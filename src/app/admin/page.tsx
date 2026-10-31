/**
 * 运维页 `/admin`（W13 C3 + D3）。
 *
 * 两个区块：
 *   ① 错误：最近 50 条去重后的错误（含重复次数与最后出现时间）
 *   ② 成本：近 7 天回答数 / token / 平均步数 / 平均与 P95 延迟，按库 top5
 *
 * 访问控制（决策①自建方案的安全底线）：
 *   - 只认 `ADMIN_EMAIL` 环境变量，且必须与登录 session 的 email 一致；
 *   - **未配置 ADMIN_EMAIL 时整页 404**，不是 403 ——
 *     403 等于告诉探测者"这里有个东西只是你没权限"，404 什么都不说。
 *
 * 为什么不做分页/搜索/删除：
 *   现在要回答的问题是"线上有没有新错、成本是多少"。
 *   50 条足够；真到了需要搜索的量级，说明该上专业工具了，而不是给这个页面加功能。
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { auth } from '@/auth';
import { log } from '@/lib/log';
import { prisma } from '@/lib/prisma';

/** 运维页不该被搜索引擎收录 —— 即使有权限校验，也不给它进索引的机会 */
export const metadata: Metadata = { title: '运维', robots: { index: false, follow: false } };

export const dynamic = 'force-dynamic';

type CostTotal = {
  answers: number;
  in_tokens: number;
  out_tokens: number;
  avg_steps: number | null;
  avg_ms: number | null;
  p95_ms: number | null;
};

type CostByKb = {
  name: string;
  answers: number;
  in_tokens: number;
  out_tokens: number;
  avg_steps: number | null;
};

/** 元/百万 token；不配就不显示金额（宁可空着，也不要写一个假单价） */
function priceOf(kind: 'in' | 'out'): number | null {
  const raw = kind === 'in' ? process.env.LLM_PRICE_IN_PER_M : process.env.LLM_PRICE_OUT_PER_M;
  const value = Number(raw);
  return raw && Number.isFinite(value) ? value : null;
}

function costOf(
  inTokens: number,
  outTokens: number,
  inPrice: number | null,
  outPrice: number | null,
): string {
  if (inPrice === null || outPrice === null) return '—';
  return `¥${((inTokens / 1_000_000) * inPrice + (outTokens / 1_000_000) * outPrice).toFixed(4)}`;
}

/**
 * 取数 + 时间戳都放在组件外。
 *
 * ⚠️ 时间戳必须在组件外取：React 的新 lint 规则（react-hooks/purity）会把
 * 渲染期的 `new Date()` 判成不纯调用。这是 Server Component，每个请求渲染一次，
 * 语义上没问题 —— 但把 impure 调用收进普通函数是更干净的写法，也顺手满足规则。
 */
async function loadAdminData() {
  const now = Date.now();
  const since = new Date(now - 7 * 24 * 3600 * 1000);
  const generatedAt = new Date(now).toLocaleString('zh-CN');

  /**
   * 用 $queryRaw 而不是 groupBy：要算 percentile_cont（P95），Prisma 的聚合 API 不支持。
   * 参数用 ${since} 走参数化占位符，不是字符串拼接。
   */
  const [errors, totals, byKb, degraded] = await Promise.all([
    prisma.errorLog.findMany({ orderBy: { lastSeen: 'desc' }, take: 50 }),
    prisma.$queryRaw<CostTotal[]>`
      select count(*)::int as answers,
             coalesce(sum(m."inputTokens"), 0)::int as in_tokens,
             coalesce(sum(m."outputTokens"), 0)::int as out_tokens,
             round(avg(m."steps"))::int as avg_steps,
             round(avg(m."latencyMs"))::int as avg_ms,
             round(percentile_cont(0.95) within group (order by m."latencyMs"))::int as p95_ms
      from "Message" m
      where m.role = 'assistant' and m."createdAt" >= ${since}
    `,
    prisma.$queryRaw<CostByKb[]>`
      select k."name" as name,
             count(*)::int as answers,
             coalesce(sum(m."inputTokens"), 0)::int as in_tokens,
             coalesce(sum(m."outputTokens"), 0)::int as out_tokens,
             round(avg(m."steps"))::int as avg_steps
      from "Message" m
      join "Conversation" c on c.id = m."conversationId"
      join "KnowledgeBase" k on k.id = c."kbId"
      where m.role = 'assistant' and m."createdAt" >= ${since}
      group by k."name"
      order by (sum(coalesce(m."inputTokens", 0)) + sum(coalesce(m."outputTokens", 0))) desc
      limit 5
    `,
    /**
     * W15：rerank 降级次数（近 24h）。
     *
     * 为什么这一格必须有：降级是**静默**的 —— 用户拿到的答案仍然正常
     * （落回纯向量 top5），只是质量悄悄退了一档。没有任何人会在界面上看到异常。
     * 如果一个降级路径从来没有人观测，那它在工程上等于不存在：
     * rerank 服务坏了三个月，也不会有人知道。
     *
     * 读 ErrorLog 而不是新开一张表：降级走的是 reportError（level=warn），
     * 指纹去重 + count 累加已经够回答"最近有没有在降级、多不多"。
     * ⚠️ 已知偏差：reportError 有 60s 进程内节流，所以这个数是**下界**，
     * 不能当精确调用次数用 —— 它回答的是"有没有事"，不是"精确多少次"。
     */
    prisma.$queryRaw<{ n: number }[]>`
      select coalesce(sum(count), 0)::int as n
      from "ErrorLog"
      where event = 'rerank.degraded'
        and "lastSeen" >= ${new Date(now - 24 * 3600 * 1000)}
    `,
  ]);

  return { errors, totals, byKb, degraded: degraded[0]?.n ?? 0, generatedAt };
}

export default async function AdminPage() {
  const session = await auth();
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const sessionEmail = session?.user?.email?.trim().toLowerCase();

  if (!adminEmail || !sessionEmail || sessionEmail !== adminEmail) {
    // 不记日志：扫描器会把它刷爆，而且这不是"产品错误"，是正常的未授权访问
    notFound();
  }

  const { errors, totals, byKb, degraded, generatedAt } = await loadAdminData();

  const t = totals[0] ?? {
    answers: 0,
    in_tokens: 0,
    out_tokens: 0,
    avg_steps: null,
    avg_ms: null,
    p95_ms: null,
  };
  const inPrice = priceOf('in');
  const outPrice = priceOf('out');

  log.debug('admin.view', { errors: errors.length, answers: t.answers });

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-10 p-8 text-sm">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">运维</h1>
        <p className="text-xs text-zinc-500">数据窗口：近 7 天 · 生成于 {generatedAt}</p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">成本与延迟</h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="回答数" value={String(t.answers)} />
          <Stat label="输入 token" value={t.in_tokens.toLocaleString()} />
          <Stat label="输出 token" value={t.out_tokens.toLocaleString()} />
          <Stat label="平均步数" value={t.avg_steps === null ? '—' : String(t.avg_steps)} />
          <Stat label="平均延迟" value={t.avg_ms === null ? '—' : `${t.avg_ms} ms`} />
          <Stat label="P95 延迟" value={t.p95_ms === null ? '—' : `${t.p95_ms} ms`} />
          <Stat label="rerank 降级（24h）" value={degraded === 0 ? '0' : String(degraded)} />
        </dl>
        <p className="text-xs text-zinc-500">
          估算成本：
          <span className="ml-1 font-medium text-zinc-800">
            {costOf(t.in_tokens, t.out_tokens, inPrice, outPrice)}
          </span>
          {inPrice === null || outPrice === null ? (
            <span className="ml-2 text-zinc-400">
              未配置 LLM_PRICE_IN_PER_M / LLM_PRICE_OUT_PER_M；单价随模型变化，写死会算错
            </span>
          ) : null}
        </p>

        {byKb.length > 0 ? (
          <table className="mt-2 w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-zinc-500">
                <th className="py-1.5 font-normal">知识库</th>
                <th className="py-1.5 font-normal">回答</th>
                <th className="py-1.5 font-normal">输入 token</th>
                <th className="py-1.5 font-normal">输出 token</th>
                <th className="py-1.5 font-normal">成本估算</th>
              </tr>
            </thead>
            <tbody>
              {byKb.map((row) => (
                <tr key={row.name} className="border-b border-zinc-100">
                  <td className="py-1.5">{row.name}</td>
                  <td className="py-1.5">{row.answers}</td>
                  <td className="py-1.5">{row.in_tokens.toLocaleString()}</td>
                  <td className="py-1.5">{row.out_tokens.toLocaleString()}</td>
                  <td className="py-1.5">
                    {costOf(row.in_tokens, row.out_tokens, inPrice, outPrice)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-zinc-400">近 7 天还没有回答记录。</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">
          错误
          {errors.length > 0 ? (
            <span className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-600">
              {errors.length} 类
            </span>
          ) : null}
        </h2>
        {errors.length === 0 ? (
          <p className="text-xs text-zinc-400">没有记录。要么真的没问题，要么上报链路没接上 —— 值得手动触发一次验证。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {errors.map((e) => (
              <li key={e.id} className="rounded-lg border border-zinc-200 p-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-600">
                    {e.event}
                  </span>
                  {e.count > 1 ? (
                    <span className="text-xs font-medium text-red-600">×{e.count}</span>
                  ) : null}
                  <span className="text-[11px] text-zinc-400">
                    最后 {new Date(e.lastSeen).toLocaleString('zh-CN')}
                  </span>
                  {e.path ? (
                    <span className="font-mono text-[11px] text-zinc-400">{e.path}</span>
                  ) : null}
                </div>
                <p className="mt-1 break-words text-xs text-zinc-800">{e.message}</p>
                {e.stack ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[11px] text-zinc-500">堆栈</summary>
                    <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-50 p-2 text-[11px] text-zinc-600">
                      {e.stack}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-3">
      <dt className="text-[11px] text-zinc-500">{label}</dt>
      <dd className="mt-0.5 text-base font-medium">{value}</dd>
    </div>
  );
}
