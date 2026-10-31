/**
 * 索引编排：把一篇文档的 content 变成数据库里带向量的 Chunk。
 *
 * 这一层是 W3 的"总装车间"，顺序很讲究，**每一步的顺序都是有理由的**：
 *
 *   ① 取 content
 *   ② 切片（纯本地计算，不花钱、可重试）
 *   ③ 批量向量化（唯一的外部付费调用）
 *   ④ 写库：删旧 → 插新 → 回填向量 → 标记 ready（放在一个事务里）
 *
 * 为什么 ③ 全部算完才动 ④？
 *   反过来（先写 chunks 再逐个补向量）的话，中途失败会在库里留下
 *   一批**没有向量的 chunk**，它们会被 W4 的检索当成有效内容捞出来，
 *   而且排序行为不可预期。先算后写，失败时库里还是上一次的完好索引
 *   （重索引场景）或者什么都没有（首次上传场景）—— 两种都比"半成品"好。
 *   这是验收 C2 能过的根本原因。
 */
import { splitText } from './chunk';
import { embedTexts } from './embedding';
import { log } from './log';
import { prisma } from './prisma';
import { findSuspicious } from './untrusted';

/**
 * 单文档的切片上限。
 *
 * ⚠️ 这条护栏独立于 W2 的 4MB 文件大小限制 —— 那是字节数，这是块数，两回事：
 * 中文 UTF-8 一个字 3 字节，4MB ≈ 140 万字 ≈ 2800 块。所以"文件不大"
 * 完全不代表"切片不多"，必须单独设限。
 *
 * 为什么是 200：200 块 ≈ 10 万字（一本小书 / 30 篇长文），按 16 条一批约 13 次
 * 请求、实测约 7 秒，能卡在 Vercel 函数超时（Hobby 10 秒）以内还留有余量。
 * 超出就明确 failed 让用户拆分，而不是转圈到平台 504 —— 后者是"静默失败"的变体。
 *
 * 什么时候改：等 W6 上了异步任务队列，把它提到 2000 只需改这一行 + 复验 F1。
 */
export const MAX_CHUNKS_PER_DOCUMENT = 200;

/**
 * 为一篇文档建立索引。
 *
 * @throws 任何一步失败都会抛出带中文原因的错误，由调用方（uploadDocument）
 *         统一转成文档的 failed 状态 —— 这里**不自己吞异常**，否则又是静默失败。
 */
export async function indexDocument(documentId: string): Promise<void> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, content: true },
  });

  if (!document) {
    throw new Error('文档不存在');
  }
  if (!document.content) {
    // W2 的解析层已经拦过一次空文本，这里是防御性的第二道（万一将来有别的写入路径）
    throw new Error('文档没有可索引的文本内容');
  }

  // ---------- ② 切片 ----------
  /**
   * W14：切片前先扫一遍疑似指令性文本。
   *
   * 位置选在这里（而不是 uploadDocument）的理由：**重索引也要扫**。
   * 用户在 W6 改过切片策略后重跑过批量 reindex，如果标记只做在首次上传路径上，
   * 老文档永远拿不到标记 —— 而老文档恰恰是最可能藏着投毒内容的。
   *
   * 只标记不阻断（spec 决策②）。写失败不影响索引：标记是**增益信息**不是正确性前提，
   * 因此单独 try/catch 吞掉并落一条 warn，绝不让它把好好的索引任务带崩。
   */
  const hits = findSuspicious(document.content);
  if (hits.length) {
    try {
      await prisma.document.update({
        where: { id: document.id },
        data: { suspiciousAt: new Date() },
      });
      log.warn('document.suspicious', { docId: document.id.slice(0, 8), hits });
    } catch (error) {
      log.warn('document.suspicious.mark_failed', {
        docId: document.id.slice(0, 8),
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const chunks = splitText(document.content);

  if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) {
    throw new Error(
      `文档过长：切成 ${chunks.length} 块，超过单文档 ${MAX_CHUNKS_PER_DOCUMENT} 块上限，请拆分后重新上传`,
    );
  }

  // ---------- ③ 向量化（唯一的外部调用，失败时数据库还是干净的） ----------
  const vectors = await embedTexts(chunks);

  if (vectors.length !== chunks.length) {
    // 理论上不可能（embedTexts 内部已校验），真发生了说明对应关系错了，绝不能带着错位继续写
    throw new Error(`向量数量与切片数量不一致（${vectors.length} vs ${chunks.length}）`);
  }

  // ---------- ④ 写库：整段放在事务里，要么全成要么全不成 ----------
  await prisma.$transaction(async (tx) => {
    /**
     * 先删旧 chunk：保证重复索引是幂等的（不会撞 @@unique([documentId, chunkIndex])），
     * 也保证重新切片后不会残留旧策略的产物。
     * 这一步在事务里，所以"删了旧的但新的没写进去"不会发生。
     */
    await tx.chunk.deleteMany({ where: { documentId } });

    /**
     * 用 createManyAndReturn 而不是 createMany：后者只返回一个 count，
     * 拿不到新记录的 id，就没法把向量写回对应的行（向量字段 Prisma 写不了，见下）。
     */
    const created = await tx.chunk.createManyAndReturn({
      data: chunks.map((content, chunkIndex) => ({ content, chunkIndex, documentId })),
      select: { id: true, chunkIndex: true },
    });

    /**
     * 回填向量 —— ⚠️ 这是 W3 最反直觉的一步。
     *
     * Chunk.embedding 在 schema 里是 `Unsupported("vector(1024)")`，
     * Prisma Client **根本不认识这个字段**：create/update 的 data 里写不进去，
     * select 也选不出来。所以只能走原生 SQL。
     *
     * 安全性：`${literal}::vector` 是**参数化**的（Prisma 的模板标签会把它变成
     * $1::vector），不是字符串拼接，没有注入风险。
     */
    for (const row of created) {
      await tx.$executeRaw`
        UPDATE "Chunk"
        SET embedding = ${toVectorLiteral(vectors[row.chunkIndex])}::vector
        WHERE id = ${row.id}
      `;
    }
  });

  await prisma.document.update({
    where: { id: documentId },
    data: { status: 'ready', error: null },
  });
}

/**
 * 把数字数组转成 pgvector 的字面量 `[0.1,-0.2,...]`。
 *
 * 校验每个值都是有限数字：NaN / Infinity 会让 pgvector 直接报错，
 * 而且错误信息完全指不到源头。宁可在这里抛一个清楚的错误。
 */
function toVectorLiteral(vector: number[]): string {
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new Error('向量里出现非数字（NaN / Infinity），无法写入数据库');
    }
  }
  return `[${vector.join(',')}]`;
}
