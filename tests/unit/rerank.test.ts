/**
 * rerank 的边界与降级单测（对应 ACCEPTANCE-W15 的 D 组）。
 *
 * 这一层测试的重点**不是"能不能排对"**，是"排不成的时候会不会把系统带崩"。
 * rerank 是一个新加的外部依赖，它对用户的价值是"答案更准一点"，
 * 但它引入的故障面是"整条问答链路可能挂" —— 这两者的量级完全不对等。
 * 所以下面一半的用例都在验同一个不变量：
 *
 *   任何失败 → 返回 chunks.slice(0, topN)，与没有这个功能时**逐元素相等**。
 *
 * 所有用例都 mock 掉 fetch：单测里一次真实网络请求都不该发生
 * （testTimeout 只有 10s，偷偷联网的测试会让人以为是机器慢）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { rerankChunks } from '@/lib/rerank';

type Chunk = { id: string; content: string };

function makeChunks(n: number): Chunk[] {
  return Array.from({ length: n }, (_, i) => ({ id: `c${i}`, content: `片段内容 ${i}` }));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  // setup-env.ts 会把 .env.local 读进来，里面有真实 key。
  // 这里换成假值：任何"忘了 mock 就真调 API"的失误都会立刻变成 401，而不是静默扣费。
  vi.stubEnv('EMBED_API_KEY', 'test-key');
  vi.stubEnv('RERANK_API_KEY', '');
  vi.stubEnv('RERANK_TIMEOUT_MS', '5000');
  // 降级会打 warn，测试输出里不需要看它
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('rerankChunks · 正常路径', () => {
  it('按 rerank 分数降序取前 topN 条', async () => {
    const chunks = makeChunks(5);
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [
          { index: 3, relevance_score: 0.91 },
          { index: 1, relevance_score: 0.72 },
          { index: 4, relevance_score: 0.3 },
        ],
      }),
    );

    const out = await rerankChunks('问题', chunks, 2);

    expect(out.degraded).toBe(false);
    expect(out.reason).toBeNull();
    expect(out.items.map((c) => c.id)).toEqual(['c3', 'c1']);
    expect(out.scores).toEqual([0.91, 0.72]);
  });

  it('服务端若按升序返回，本地仍按分数降序重排（不假设对方排序语义）', async () => {
    const chunks = makeChunks(3);
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [
          { index: 0, relevance_score: 0.1 },
          { index: 2, relevance_score: 0.9 },
          { index: 1, relevance_score: 0.5 },
        ],
      }),
    );

    const out = await rerankChunks('问题', chunks, 3);

    expect(out.items.map((c) => c.id)).toEqual(['c2', 'c1', 'c0']);
  });

  it('候选数少于 topN 时不报错，全部返回（D7）', async () => {
    const chunks = makeChunks(3);
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [
          { index: 2, relevance_score: 0.8 },
          { index: 0, relevance_score: 0.6 },
          { index: 1, relevance_score: 0.4 },
        ],
      }),
    );

    const out = await rerankChunks('问题', chunks, 5);

    expect(out.degraded).toBe(false);
    expect(out.items).toHaveLength(3);
  });

  it('请求体里 return_documents 必须为 false（否则响应白扛一堆原文）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [{ index: 0, relevance_score: 1 }] }));

    await rerankChunks('问题', makeChunks(2), 1);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.return_documents).toBe(false);
    expect(body.top_n).toBe(1);
  });
});

describe('rerankChunks · 输入侧边界', () => {
  it('空候选数组随即返回，不发请求（D4）', async () => {
    const out = await rerankChunks('问题', [], 5);

    expect(out).toEqual({ items: [], scores: [], degraded: false, reason: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('没有 API key 时降级，且不尝试请求', async () => {
    vi.stubEnv('EMBED_API_KEY', '');
    vi.stubEnv('RERANK_API_KEY', '');

    const chunks = makeChunks(8);
    const out = await rerankChunks('问题', chunks, 5);

    expect(out.degraded).toBe(true);
    expect(out.reason).toBe('no_api_key');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('rerankChunks · 服务端返回的脏数据', () => {
  it('返回条数不足时按原顺序补位，补位项分数为 null（D1）', async () => {
    const chunks = makeChunks(6);
    // 只给了 2 条，而我们要 4 条
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [
          { index: 4, relevance_score: 0.9 },
          { index: 2, relevance_score: 0.8 },
        ],
      }),
    );

    const out = await rerankChunks('问题', chunks, 4);

    expect(out.items.map((c) => c.id)).toEqual(['c4', 'c2', 'c0', 'c1']);
    expect(out.scores).toEqual([0.9, 0.8, null, null]);
  });

  it('重复的 index 只取一次，且不重复占用名额（D6）', async () => {
    const chunks = makeChunks(4);
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [
          { index: 1, relevance_score: 0.9 },
          { index: 1, relevance_score: 0.85 },
          { index: 3, relevance_score: 0.7 },
        ],
      }),
    );

    const out = await rerankChunks('问题', chunks, 3);

    expect(out.items.map((c) => c.id)).toEqual(['c1', 'c3', 'c0']);
  });

  it('越界 index 直接丢弃，不抛错（D6）', async () => {
    const chunks = makeChunks(3);
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [
          { index: 99, relevance_score: 0.99 },
          { index: -1, relevance_score: 0.98 },
          { index: 1, relevance_score: 0.5 },
        ],
      }),
    );

    const out = await rerankChunks('问题', chunks, 2);

    expect(out.degraded).toBe(false);
    expect(out.items.map((c) => c.id)).toEqual(['c1', 'c0']);
  });

  it('results 不是数组 → 降级', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: 'oops' }));

    const chunks = makeChunks(3);
    const out = await rerankChunks('问题', chunks, 2);

    expect(out.degraded).toBe(true);
    expect(out.reason).toBe('bad_payload');
  });

  it('全部 index 都非法 → 降级而不是返回空数组', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ results: [{ index: 99, relevance_score: 1 }] }),
    );

    const chunks = makeChunks(3);
    const out = await rerankChunks('问题', chunks, 2);

    expect(out.degraded).toBe(true);
    expect(out.reason).toBe('empty_results');
    expect(out.items.map((c) => c.id)).toEqual(['c0', 'c1']);
  });

  it('分数不是数字 → 该条被丢弃', async () => {
    const chunks = makeChunks(3);
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [
          { index: 0, relevance_score: 'high' },
          { index: 2, relevance_score: 0.4 },
        ],
      }),
    );

    const out = await rerankChunks('问题', chunks, 2);

    expect(out.items.map((c) => c.id)).toEqual(['c2', 'c0']);
  });
});

describe('rerankChunks · 传输层失败（降级不变量 D5）', () => {
  const chunks = makeChunks(10);

  /** 降级的唯一判据：结果必须与"没有 rerank"逐元素相等。 */
  function expectLosslessFallback(out: Awaited<ReturnType<typeof rerankChunks>>) {
    expect(out.degraded).toBe(true);
    expect(out.items).toEqual(chunks.slice(0, 5));
    expect(out.scores).toEqual([]);
  }

  it('网络错误 → 重试 3 次后降级', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed'));

    const out = await rerankChunks('问题', chunks, 5);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expectLosslessFallback(out);
    expect(out.reason).toBe('network');
  });

  it('超时 → reason 为 timeout（而不是笼统的 network）', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));

    const out = await rerankChunks('问题', chunks, 5);

    expectLosslessFallback(out);
    expect(out.reason).toBe('timeout');
  });

  it('持续 429 → 重试后降级', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'rate limited' }, 429));

    const out = await rerankChunks('问题', chunks, 5);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expectLosslessFallback(out);
    expect(out.reason).toBe('http_429');
  });

  it('5xx 会重试，但 4xx 不重试（重试也还是错）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'bad request' }, 400));

    const out = await rerankChunks('问题', chunks, 5);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectLosslessFallback(out);
    expect(out.reason).toBe('http_400');
  });

  it('第一次 500、第二次成功 → 不降级（重试是有意义的）', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            { index: 7, relevance_score: 0.9 },
            { index: 0, relevance_score: 0.1 },
          ],
        }),
      );

    const out = await rerankChunks('问题', chunks, 2);

    expect(out.degraded).toBe(false);
    expect(out.items.map((c) => c.id)).toEqual(['c7', 'c0']);
  });
});
