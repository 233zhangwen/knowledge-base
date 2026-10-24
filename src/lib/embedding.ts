/**
 * 向量化：把一批文本变成向量（embedding）。
 *
 * 选型说明（为什么这里没用 Vercel AI SDK）：
 *   本项目 W4 的"生成"环节会用 AI SDK（流式输出、工具调用那套确实需要它），
 *   但向量化这一层刻意用原生 fetch —— 因为我们要精细控制三件事：
 *     ① 批量大小（省钱 + 避免触发服务商的单请求总 token 限制）
 *     ② 失败重试（429 限流在批量调用时是常态，一次抖动就判死不可接受）
 *     ③ 维度校验（写进 pgvector 之前必须确认是 1024 维）
 *   这三件事用 SDK 反而要绕着它写。整个项目的"可替换 provider"思路不变：
 *   换服务商 = 改 .env.local 的三个变量，业务代码一行不动。
 */

/** 必须和 prisma/schema.prisma 里 vector(1024) 一致。改一个就得改另一个（含索引）。 */
export const EMBED_DIMENSIONS = 1024;

/**
 * 单批条数。
 *
 * 实测（scripts/verify-embedding.mjs）：32 条**短文本**能通过。但真实的 chunk 是
 * 500 字一块，32 块就是一万六千字 —— 批量失败的门槛通常是"单请求总 token"
 * 而不是"条数"，所以这里留一倍余量取 16。等到真的撞上限再往上调，方向是安全的。
 */
const BATCH_SIZE = 16;

/** 最多试 3 次（首次 + 2 次重试），退避间隔 500ms / 1500ms。 */
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 1500];

/** 带状态码的错误：用来区分"该重试"和"该立刻认输"。 */
class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

function readConfig() {
  const apiKey = process.env.EMBED_API_KEY;
  const model = process.env.EMBED_MODEL;
  const baseUrl = (process.env.EMBED_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');

  /**
   * 配置缺失要**立刻炸且给出人话**。
   * 这类错误重试一万次也不会成功，如果混进重试逻辑，用户只会看到"转圈很久然后失败"。
   */
  if (!apiKey || !model) {
    throw new EmbeddingError(
      '缺少 EMBED_API_KEY / EMBED_MODEL 配置，检查 .env.local（可跑 node scripts/verify-embedding.mjs 验证）',
    );
  }

  return { apiKey, model, endpoint: `${baseUrl}/embeddings` };
}

/**
 * 把一批文本变成向量。
 *
 * 返回的数组与入参**一一对应**（下标对齐），调用方可以放心用
 * `vectors[i]` 对应 `texts[i]`。这个对应关系一旦错位，检索结果就会
 * "驴唇不对马嘴"，而且不报错 —— 所以下面专门校验了返回条数。
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const vectors: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    vectors.push(...(await embedBatchWithRetry(batch)));
  }

  return vectors;
}

async function embedBatchWithRetry(input: string[]): Promise<number[][]> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await requestEmbeddings(input);
    } catch (error) {
      lastError = error;

      // 401（密钥错）/ 400（参数错）这类重试一万次也是同一个结果，直接认输
      if (!isRetryable(error)) {
        throw error;
      }

      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        break; // 重试次数用完了
      }

      console.warn(
        `[embedding] 第 ${attempt + 1} 次失败，${delay}ms 后重试：${error instanceof Error ? error.message : String(error)}`,
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

/** 什么情况值得重试：网络断了、被限流（429）、服务端出错（5xx）。 */
function isRetryable(error: unknown): boolean {
  if (error instanceof EmbeddingError && error.status !== undefined) {
    return error.status === 429 || error.status >= 500;
  }
  // fetch 的网络层失败（DNS、连接被重置）没有状态码，属于典型的可重试错误
  return true;
}

async function requestEmbeddings(input: string[]): Promise<number[][]> {
  const { apiKey, model, endpoint } = readConfig();

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input }),
    });
  } catch (error) {
    // 网络层错误：把原因说清楚，别让用户看到一个光秃秃的 "fetch failed"
    throw new EmbeddingError(
      `请求 embedding 服务失败（${error instanceof Error ? error.message : String(error)}）`,
    );
  }

  const raw = await res.text();

  if (!res.ok) {
    let detail = raw.slice(0, 300);
    try {
      const json = JSON.parse(raw);
      detail = json.message ?? json.error?.message ?? detail;
    } catch {
      /* 不是 JSON 就原样带上 */
    }
    throw new EmbeddingError(`embedding 服务返回 HTTP ${res.status}：${detail}`, res.status);
  }

  const json = JSON.parse(raw) as {
    data?: Array<{ index?: number; embedding?: number[] }>;
  };

  if (!Array.isArray(json.data) || json.data.length !== input.length) {
    throw new EmbeddingError(
      `返回条数对不上（要 ${input.length} 条，收到 ${json.data?.length ?? 0} 条）`,
    );
  }

  /**
   * 按 index 归位，而不是直接用数组顺序。
   * OpenAI 兼容接口规定返回顺序与输入一致，但既然响应里带了 index，
   * 就别把正确性押在别人的实现细节上 —— 错位是最难查的一类 bug。
   */
  const ordered: number[][] = new Array(input.length);
  for (const item of json.data) {
    const index = item.index ?? 0;
    const vector = item.embedding;

    if (!Array.isArray(vector)) {
      throw new EmbeddingError('响应里缺少 embedding 数组');
    }
    if (vector.length !== EMBED_DIMENSIONS) {
      throw new EmbeddingError(
        `维度不对：期望 ${EMBED_DIMENSIONS}，实际 ${vector.length}。` +
          `检查 EMBED_MODEL 是否为 BAAI/bge-m3（改模型就得改 schema 的 vector(N) 并重跑迁移）`,
      );
    }

    ordered[index] = vector;
  }

  if (ordered.some((v) => v === undefined)) {
    throw new EmbeddingError('返回的向量下标有缺失，无法与输入对齐');
  }

  return ordered;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
