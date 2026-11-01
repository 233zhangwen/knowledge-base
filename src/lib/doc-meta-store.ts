/**
 * 元数据落库：抽取、解算、写回（W17）。
 *
 * 与 doc-meta.ts 的分工很清楚：
 *   `doc-meta.ts`     纯函数 —— 抽什么、怎么对齐、怎么推导状态，**不碰数据库**
 *   `doc-meta-store.ts`（本文件）—— 读库、调纯函数、写库
 *
 * 为什么必须分开：doc-meta 的单测要能在没有 DATABASE_URL 的 CI 里跑。
 * W13 踩过一次 —— 一个"纯函数"文件顶层就 new PrismaClient，整个 CI 变红。
 * 这个边界不是洁癖，是那条踩出来的坑。
 */
import { extractDocMeta, resolveMetas } from './doc-meta';
import { log } from './log';
import { prisma } from './prisma';

export type RefreshResult = {
  /** 参与解算的文档数 */
  total: number;
  /** 实际发生变化的文档数（内容没变就不写，避免每次上传都刷全库） */
  changed: number;
};

/**
 * 重算某个知识库内所有文档的废止关系。
 *
 * ## 为什么新上传一篇就要重算全库
 *
 * `supersededBy` 是反向关系：C 说自己废止了 E，被改的是 **E 的字段**。
 * 新上传 C 的那一刻，E 可能在几个月前就进来了 —— 只处理新文档，E 永远标不上。
 *
 * ## 为什么这个代价可以接受
 *
 * 只读 4 个短字段（title / docTitle / effectiveFrom / supersedesRaw），
 * 不读 content。几十篇文档总共也就几 KB，一次 SELECT 就回来了。
 * 如果这里读 content，一篇 4MB 的 PDF 就让每次上传多背一个 4MB。
 *
 * ## 失败怎么办
 *
 * 抛出。调用方（indexDocument）选择吞掉并 warn：元数据是**增益信息**，
 * 抽不到的时候检索照跑，只是模型少一个判断依据 —— 和 suspicious 同一条纪律。
 * 反过来若让它把索引任务带崩，就是"因为标注失败导致文档不可用"，得不偿失。
 */
export async function refreshKbDocMeta(kbId: string): Promise<RefreshResult> {
  const docs = await prisma.document.findMany({
    /**
     * 只算 ready 的文档。
     *
     * 一篇 `failed` 的文档在检索里永远不会被返回（retrieve 有 `status = 'ready'` 过滤），
     * 但它如果声称"废止了 X"，仍然会把 X 标成已废止 —— 于是 X 在检索结果里
     * 挂着「已废止」而模型找不到任何取代者。**用一份取不到的文件去否定一份取得到的文件**，
     * 这比不标危险得多。
     */
    where: { kbId, status: 'ready' },
    select: {
      id: true,
      title: true,
      docTitle: true,
      effectiveFrom: true,
      supersedesRaw: true,
      supersededBy: true,
    },
  });

  if (!docs.length) return { total: 0, changed: 0 };

  const { metas, alignFailures } = resolveMetas(
    docs.map((d) => ({
      title: d.title,
      docTitle: d.docTitle,
      effectiveFrom: d.effectiveFrom,
      supersedesRaw: d.supersedesRaw,
    })),
  );

  /**
   * 按**下标**对应回 id，不按 title 查回来：
   * `resolveMetas` 保证输出顺序与输入一致，用下标是确定的。
   * 用 title 去找 id 会有一个隐性假设（同库内 title 唯一），
   * 而这个假设在数据库层面**没有约束** —— 用户完全可能传两份同名文件。
   * 那种情况下 Map 会只留下一个，另一份静默不更新。
   */
  const writes = metas
    .map((m, i) => ({ meta: m, doc: docs[i] }))
    .filter(({ meta, doc }) => doc.supersededBy !== meta.supersededBy);

  if (writes.length) {
    await prisma.$transaction(
      writes.map(({ meta, doc }) =>
        prisma.document.update({
          where: { id: doc.id },
          data: { supersededBy: meta.supersededBy },
        }),
      ),
    );
  }

  for (const f of alignFailures) {
    /**
     * 只记「要人看」的失败。not-found 绝大多数是引用了库外文件
     * （《员工手册（2021 版）》根本没上传），每条都报会把真正的异常淹掉。
     */
    if (f.reason === 'not-found') continue;
    log.warn('docmeta.align_failed', { from: f.from, ref: f.ref, reason: f.reason });
  }

  return { total: docs.length, changed: writes.length };
}

/**
 * 抽取单篇文档的元数据并写入（不做废止关系解算 —— 那是 refreshKbDocMeta 的事）。
 *
 * 调用时机：文档的 content 落库之后、建索引之前。之所以能和建索引解耦：
 * 元数据只依赖 content，不依赖 chunk 和向量。
 */
export async function extractAndSaveDocMeta(documentId: string, content: string): Promise<void> {
  const m = extractDocMeta(content);
  await prisma.document.update({
    where: { id: documentId },
    data: {
      docTitle: m.docTitle,
      effectiveFrom: m.effectiveFrom,
      supersedesRaw: m.supersedesRaw,
    },
  });
  if (m.warnings.length) {
    log.warn('docmeta.extract_warn', { docId: documentId.slice(0, 8), warnings: m.warnings });
  }
}
