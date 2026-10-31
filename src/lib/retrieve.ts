/**
 * 检索：把用户的问题变成问句向量，在这个**知识库内部**找出最相关的若干片段。
 *
 * W15 起变成**两段式**：
 *
 * ```
 * recall(kbId, question, RECALL_K)      向量粗排，从全库捞 20 条   ← bi-encoder，便宜
 *        ↓
 * rerankChunks(question, candidates, K) cross-encoder 精排，挑 5 条 ← 贵，但只算 20 对
 * ```
 *
 * 为什么必须两段：cross-encoder 要把 (问题, 块) 拼起来跑一次前向，
 * 100 块就是 100 次，没法像向量那样预建索引。所以它只配用在最后一段。
 * 详见 `src/lib/rerank.ts` 顶部。
 *
 * 三个关键约束（原样保留，每条都是为了 spec 里某条验收标准存在的）：
 *
 * ① `where d."kbId" = ${kbId}` —— 对应 A1 / D1。
 *    没有这一句，用户会在这个知识库里问出隔壁知识库、甚至别人账号的内容，
 *    而界面上看起来完全正常（引用照样挂着一串相关段落）。这是**静默事故**，
 *    比报错危险得多。kbId 由调用方传入，但调用方必须已经做过归属校验。
 *
 * ② `and d.status = 'ready'` —— 对应 C3。
 *    W3 的失败流程可能给 failed 文档留下旧 chunks（重索引前的残留），
 *    不去过滤的话，"解析失败的文档照样能被搜出来"这种事就会发生。
 *
 * ③ 排序必须用 `<=>`（余弦距离，**越小越相似**）—— 对应 A2。
 *    它和 `<->`（欧氏距离）长得像但语义不同，写反了照样有结果、照样不报错，
 *    只是检索质量悄悄变差。similarity 用 `1 - distance` 转回"越大越像"。
 *
 * 注：`limit ${...}` 里的 ${} 是 Prisma 的**参数化占位符**（会变成 $N），
 * 不是字符串拼接 —— 和 $3::vector 一样，没有注入风险。
 */
import { embedTexts } from './embedding';
import { reportError } from './error-report';
import { log } from './log';
import { prisma } from './prisma';
import { rerankChunks } from './rerank';

/**
 * 最终喂给模型的条数。理由（写进 ACCEPTANCE-W4.md 决策①）：
 * 5 块 × 约 500 字 ≈ 2500 字，远在模型上下文窗口内，所以限制我们的不是窗口大小，
 * 而是**注意力稀释** —— 塞 20 条进去，真正有用的那条反而被淹没。
 */
export const TOP_K = 5;

/**
 * 粗排候选池大小。
 *
 * ⚠️ **这个值是被数据推翻过一次的，改它之前先读 `eval/rerank-results.md`。**
 *
 * spec 决策① 原本拍的是 20（"行业甜点位"）。实测四档对照后改成 10：
 *
 *   | 组  | ΔMRR@5 | Δp95     |
 *   |-----|--------|----------|
 *   | R10 | +0.119 | +354ms   |  ← 两条判据都过
 *   | R20 | +0.135 | +559ms   |  ← 延迟超预算
 *   | R50 | +0.135 | +864ms   |  ← 与 R20 完全相同的收益，纯浪费
 *
 * 20 相比 10 只多 0.016 MRR（相对提升 13%），却多付 200ms 延迟。
 * 而 R20 与 R50 的收益**一模一样**——说明候选池到 20 就已经饱和，
 * 再往上加只是在为同一条答案排更长的队。
 *
 * ⚠️ 它与库规模强相关：本库 40 块，10 条覆盖 25%。
 * **库涨到几百块之后必须重测**——候选池占全库比例太低会漏召回，
 * 到时候该涨的是这个数，不是 TOP_K。
 */
export const RECALL_K = 10;

export type RetrievedChunk = {
  id: string;
  content: string;
  chunkIndex: number;
  documentId: string;
  documentTitle: string;
  /** 余弦相似度，0~1，越大越相似。仅用于日志观测，不用于裁断是否回答。 */
  similarity: number;
  /** W14：该文档入库时被标记为含疑似指令性文本（只标记不阻断，见 untrusted.ts） */
  suspicious: boolean;
  /**
   * W15：cross-encoder 给的分数。与 similarity **尺度完全不同**（logits vs 余弦），
   * 两者绝不能混用或互相比较。降级时为 null（那一轮根本没算分）。
   */
  rerankScore?: number | null;
};

type Row = {
  id: string;
  content: string;
  chunkIndex: number;
  documentId: string;
  title: string;
  similarity: number;
  suspicious: boolean;
};

/**
 * 第一段：向量粗排。
 *
 * 单独导出的理由不只是"给 retrieve 用"——评测脚本要能**只跑粗排**，
 * 拿它当"没有 rerank 时的对照组"。如果只有 retrieve 一个出口，
 * 对照组就只能靠改代码或改 env 来构造，那种对照跑两次就不是同一份代码了。
 */
export async function recall(
  kbId: string,
  question: string,
  limit: number,
): Promise<RetrievedChunk[]> {
  const t0 = Date.now();

  const [vector] = await embedTexts([question]);
  const vectorLiteral = `[${vector.join(',')}]`;

  const rows = await prisma.$queryRaw<Row[]>`
    select c.id,
           c.content,
           c."chunkIndex",
           d.id as "documentId",
           d.title,
           (d."suspiciousAt" is not null) as suspicious,
           1 - (c.embedding <=> ${vectorLiteral}::vector) as similarity
    from "Chunk" c
    join "Document" d on d.id = c."documentId"
    where d."kbId" = ${kbId} and d.status = 'ready'
    order by c.embedding <=> ${vectorLiteral}::vector
    limit ${limit}
  `;

  const chunks = rows.map((r) => ({
    id: r.id,
    content: r.content,
    chunkIndex: r.chunkIndex,
    documentId: r.documentId,
    documentTitle: r.title,
    // pg 的 numeric/double precision 经 Node 驱动回来是字符串，必须显式转 Number
    similarity: Number(r.similarity),
    suspicious: Boolean(r.suspicious),
  }));

  /**
   * E2 要求的观测日志：每次检索一行。
   * W13 起改成结构化（单行 JSON）：召回条数、top1 相似度、耗时都是要能聚合的数值，
   * 埋在中文串里只能靠肉眼看。
   */
  log.info('recall.done', {
    kbId: kbId.slice(0, 8),
    limit,
    hits: chunks.length,
    top1: chunks[0] ? Number(chunks[0].similarity.toFixed(4)) : null,
    ms: Date.now() - t0,
  });

  return chunks;
}

/**
 * 对外唯一入口。**签名与返回类型自 W4 起没变过** ——
 * agent-llm / rag-prompt / 所有评测脚本都零改动，W14 的 suspicious 字段照旧透传。
 */
export async function retrieve(kbId: string, question: string): Promise<RetrievedChunk[]> {
  const t0 = Date.now();

  const candidates = await recall(kbId, question, RECALL_K);
  const { items, scores, degraded, reason } = await rerankChunks(question, candidates, TOP_K);

  /**
   * 降级时 items 就是 candidates.slice(0, TOP_K)，与"没有 rerank"逐元素相等。
   * 这条不变量是 spec D5 单测的重点：它保证"rerank 挂了"和"rerank 没上线"
   * 对用户是同一件事，而不是一次没有告警的质量下降。
   */
  const result: RetrievedChunk[] = items.map((c, i) => ({ ...c, rerankScore: scores[i] ?? null }));

  /**
   * 降级必须落一条可数的记录（spec 决策②）。
   *
   * 放在这里而不是 rerank.ts 里：rerank.ts 是纯逻辑（只依赖 log），
   * 单测直接 import 它、不需要数据库。一旦让 rerank.ts 依赖 prisma，
   * 那个单测就会因为"CI 没有 DATABASE_URL"整片变红 —— W13 踩过一次的坑。
   * 上报是**调用方的责任**，这也符合 reportError 自己的定位（业务层决定要不要报）。
   *
   * `void` 不 await：上报的延迟不该进用户的等待路径（error-report.ts 铁律 3）。
   */
  if (degraded) {
    void reportError({
      level: 'warn',
      event: 'rerank.degraded',
      message: `rerank 降级：${reason ?? 'unknown'}`,
      path: '/lib/retrieve',
    });
  }

  log.info('retrieve.done', {
    kbId: kbId.slice(0, 8),
    candidates: candidates.length,
    kept: result.length,
    rerank: degraded ? `degraded:${reason}` : 'ok',
    ms: Date.now() - t0,
  });

  return result;
}
