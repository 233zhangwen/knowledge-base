/**
 * 精排（rerank）：用 cross-encoder 把「粗排捞回来的 N 条」重新打分排序。
 *
 * ## 为什么需要这一层
 *
 * 向量检索是 bi-encoder：问题向量和块向量**各自独立算出来**，算余弦之前
 * 两者从没见过对方。它擅长"主题相近"，但对下面这些区分性信息几乎无感：
 *
 *   - 否定：「试用期**不**享受年假」vs「试用期享受年假」——否定词只占 1~2 个 token，
 *     在 1024 维向量里被平均掉了，实测这两句的余弦差在小数第三位。
 *   - 版本：「2024 版年假 12 天」vs「2026 版年假 17 天」——两块 95% 的文本相同，
 *     向量几乎重合，谁排前面由浮点噪声决定。
 *   - 主体：「母公司住宿 600」vs「成都研发中心住宿 450」——只差一个主体名。
 *
 * cross-encoder 把 `(question, chunk)` **拼成一个序列**送进模型，注意力可以直接
 * 建模"问题里的『年假』↔ 块里的『12 天』"这种跨文本对应，也能看见"2024"和"2026"。
 *
 * ## 代价与它的必然结果
 *
 * 每个 (q, c) 对都要跑一次前向 —— 100 块就是 100 次，没办法像向量那样预建索引。
 * 所以它只能用在**最后一段**：粗排负责把范围从"全库"缩到 20 条，精排负责在这
 * 20 条里挑出 5 条。这就是所谓两段式召回。
 *
 * ## 这个文件最重要的一段代码不是请求，是 fallback()
 *
 * rerank 是**新加的外部依赖**。它会超时、会 429、会额度耗尽、会返回条数不足。
 * 任何一次抖动都不能把整个问答打挂 —— 那等于用一个"锦上添花"的排序优化，
 * 换来了一个"整站不可用"的故障面。
 * 所以降级路径必须是**无损**的：返回的数组要和纯向量 top5 逐元素相等，
 * 用户完全无感，只有日志和 /admin 上留一条降级记录。
 */

import { log } from './log';

/** 默认模型。env 里 `RERANK_MODEL` 从 W4 就预留了，一直空着 —— 这周才第一次真的用上。 */
const DEFAULT_MODEL = 'BAAI/bge-reranker-v2-m3';

/**
 * 超时预算。
 *
 * 3000ms 的依据：eval 实测单次 rerank（20 条候选）在 200~600ms；
 * 留 5 倍余量是为了容忍服务端排队，但不能无限等 ——
 * 用户等一个答案的心理阈值在 10 秒左右，粗排 + LLM 生成已经吃掉大半。
 * 超时就降级，比让用户干等更符合"可用性优先"。
 */
const DEFAULT_TIMEOUT_MS = 3000;

/** 429 / 5xx 重试次数。与 embedding.ts 同口径（首次 + 2 次重试）。 */
const MAX_ATTEMPTS = 3;

function baseUrl(): string {
  return (process.env.EMBED_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
}

/**
 * API Key：优先 `RERANK_API_KEY`，没配就复用 `EMBED_API_KEY`。
 * 两者是同一个服务商（硅基流动），一个 key 同时管 embedding 与 rerank。
 * 留独立变量是为了将来换 provider 时能只换一半。
 */
function apiKey(): string {
  return process.env.RERANK_API_KEY || process.env.EMBED_API_KEY || '';
}

function timeoutMs(): number {
  const v = Number(process.env.RERANK_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

export type RerankCandidate = { id: string; content: string };

export type RerankOutcome<T extends RerankCandidate> = {
  /** 排好序的前 topN 条。降级时就是入参的前 topN 条（原样，不重排）。 */
  items: T[];
  /**
   * 与 items 一一对应的 rerank 分数，越大越相关。
   * 补位进来的项没有分数，记 null —— **不要用 0 代替**：
   * 0 是一个合法的分数（完全不相关），会被后续统计当成真值。
   */
  scores: (number | null)[];
  /** 是否走了降级路径。false 表示这次排序结果确实来自模型。 */
  degraded: boolean;
  /** 降级原因，非降级时为 null。用于日志聚合与 /admin 展示。 */
  reason: string | null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 精排入口。
 *
 * 设计上的两条硬约束（都对应 spec 的 D 组）：
 *   ① **永不抛异常**。所有失败都转成 `degraded: true` 的正常返回。
 *      （调用方 retrieve() 绝不该为了 rerank 的抖动去写 try/catch。）
 *   ② 降级时返回的 items 必须是 `chunks.slice(0, topN)` —— 与没接 rerank 时
 *      **逐元素相等**，这样"降级"和"没上线这个功能"对用户是同一件事。
 */
export async function rerankChunks<T extends RerankCandidate>(
  question: string,
  chunks: T[],
  topN: number,
): Promise<RerankOutcome<T>> {
  const t0 = Date.now();

  const fallback = (reason: string): RerankOutcome<T> => {
    log.warn('rerank.degraded', {
      reason,
      candidates: chunks.length,
      ms: Date.now() - t0,
    });
    return { items: chunks.slice(0, topN), scores: [], degraded: true, reason };
  };

  // D4：空输入短路。不发请求、不算降级（本来就没活干，不算"坏了"）。
  if (!chunks.length) {
    return { items: [], scores: [], degraded: false, reason: null };
  }

  const key = apiKey();
  if (!key) return fallback('no_api_key');

  const model = process.env.RERANK_MODEL || DEFAULT_MODEL;
  const want = Math.min(topN, chunks.length);
  let lastError = 'unknown';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`${baseUrl()}/rerank`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          query: question,
          documents: chunks.map((c) => c.content),
          top_n: want,
          /**
           * ⚠️ 必须显式 false。默认 true 会把每条候选的**原文**塞回响应里，
           * 20 条 × 500 字 ≈ 30KB 白流量 —— 而原文我们手里本来就有。
           */
          return_documents: false,
        }),
        signal: AbortSignal.timeout(timeoutMs()),
      });

      if (res.status === 429 || res.status >= 500) {
        lastError = `http_${res.status}`;
        if (attempt < MAX_ATTEMPTS) {
          await sleep(400 * attempt);
          continue;
        }
        return fallback(lastError);
      }

      // 4xx（除 429）重试没有意义：key 错了、模型名错了、额度没了，重试还是错。
      if (!res.ok) return fallback(`http_${res.status}`);

      const json = (await res.json()) as { results?: unknown };
      if (!Array.isArray(json.results)) return fallback('bad_payload');

      return pickOrdered(question, chunks, topN, json.results, fallback, t0);
    } catch (error) {
      /**
       * AbortSignal.timeout 抛的是 TimeoutError（name）。
       * 网络错误走同一个 catch —— 两者对调用方的意义是一样的：这次没排成。
       */
      const name = error instanceof Error ? error.name : 'unknown';
      lastError = name === 'TimeoutError' ? 'timeout' : 'network';
      log.warn('rerank.attempt_failed', { attempt, reason: lastError });
      if (attempt < MAX_ATTEMPTS) await sleep(400 * attempt);
    }
  }

  return fallback(lastError);
}

/**
 * 把服务端返回的 results 变成最终顺序。
 *
 * 单独拆出来是因为这里有三个坑，全都必须挡住，否则排序会**静默错乱**
 * （错乱的排序不会报错，只会让答案变差 —— 是最难发现的一类 bug）：
 *
 *   D6  重复 / 越界的 index
 *   D1  返回条数少于请求条数（模型会截断，也可能服务端限流悄悄少给）
 *   ——   服务端已经排好序，但本地再排一次：排序语义是人家定义的，
 *        我们不能假设它永远按 relevance_score 降序。
 */
function pickOrdered<T extends RerankCandidate>(
  question: string,
  chunks: T[],
  topN: number,
  rawResults: unknown[],
  fallback: (reason: string) => RerankOutcome<T>,
  t0: number,
): RerankOutcome<T> {
  const seen = new Set<number>();
  const ranked: { idx: number; score: number }[] = [];

  for (const item of rawResults) {
    const row = item as { index?: unknown; relevance_score?: unknown };
    const idx = Number(row?.index);
    const score = Number(row?.relevance_score);

    if (!Number.isInteger(idx) || idx < 0 || idx >= chunks.length) continue; // 越界：丢弃
    if (seen.has(idx)) continue; // 重复：丢弃（保留第一次出现的位置）
    if (!Number.isFinite(score)) continue; // 分数不是数字：丢弃

    seen.add(idx);
    ranked.push({ idx, score });
  }

  if (!ranked.length) return fallback('empty_results');

  ranked.sort((a, b) => b.score - a.score);

  const want = Math.min(topN, chunks.length);
  const picked = ranked.slice(0, want).map((r) => ({ idx: r.idx, score: r.score as number | null }));

  /**
   * D1 补位：服务端给少了怎么办。
   *
   * 补位的来源是**入参顺序**（chunks 已按余弦相似度降序），不是瞎补 ——
   * 这样"被 rerank 漏掉的那条"至少还能保住它粗排时的排位。
   * 补位项的分数记 null（见 RerankOutcome.scores 的注释）。
   */
  let supplemented = 0;
  if (picked.length < want) {
    for (let i = 0; i < chunks.length && picked.length < want; i += 1) {
      if (seen.has(i)) continue;
      seen.add(i);
      picked.push({ idx: i, score: null });
      supplemented += 1;
    }
  }

  log.info('rerank.done', {
    qLen: question.length,
    candidates: chunks.length,
    returned: rawResults.length,
    kept: picked.length,
    supplemented,
    top1: typeof picked[0]?.score === 'number' ? Number(picked[0].score.toFixed(4)) : null,
    ms: Date.now() - t0,
  });

  return {
    items: picked.map((p) => chunks[p.idx]),
    scores: picked.map((p) => p.score),
    degraded: false,
    reason: null,
  };
}
