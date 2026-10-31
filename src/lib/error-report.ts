/**
 * 错误上报（W13 C 组，决策①自建）。
 *
 * 和 log.ts 的分工：
 *   log  = 全量流水，用来回答"刚才发生了什么"（会刷、会被平台截断）
 *   report = 精选错误，用来回答"有哪些错还没修"（去重、持久化、可数）
 * 所以 reportError 是**双写**：先打一条 error 日志（保证现场），再落一条 ErrorLog（保证可检索）。
 *
 * 三条铁律：
 *   1. **绝不让上报本身把主流程带崩**。DB 挂了、表不存在、超时 —— 全部吞掉，
 *      最多再打一条 warn。监控把自己变成故障源是最难查的那类事故。
 *   2. **指纹必须稳定**。同一段代码同一个 message 必须得到同一个指纹，
 *      否则去重失效（一次故障=几百行）。所以指纹里不含时间、不含随机 id。
 *   3. **调用方一律 `void reportError(...)`**，不要 await —— 上报的延迟不该进用户路径。
 */
import { createHash } from 'node:crypto';

import { log } from './log';
import { prisma } from './prisma';

type ReportInput = {
  level?: 'error' | 'warn';
  /** 点分事件名，与 log.ts 的 evt 同名，方便日志/DB 两边对账 */
  event: string;
  message: string;
  stack?: string;
  /** 出错的页面或接口路径，如 /kb/[id] 或 /api/kb/[id]/chat-agent */
  path?: string;
  /**
   * React 的 error digest（Next 生产环境下页面错误的唯一编号）。
   * ⚠️ 绝不能进指纹 —— 它每次出错都不同，进指纹等于把去重废掉。
   * 这里选择"追加到 stack 末尾"而不是单开一列：只为搜索方便，不值得为它加一次迁移。
   */
  digest?: string;
};

/**
 * 进程内节流：同一指纹 60 秒内最多写一次。
 *
 * 为什么需要：前端渲染错误可能因为 React 重试 / 用户狂点刷出成千上万次上报请求，
 * DB 去重（fingerprint unique）能保证不重复建行，但**每次上报都是一次写库**，
 * 流量照样能把免费层连接数打满。这里在入口先挡一道。
 *
 * 可配置（ERROR_REPORT_THROTTLE_MS）：默认 60s；设成 0 就等于关闭节流。
 * 之所以做成环境变量而不是常量：DB 测试要验证"去重累加"就必须连写多次，
 * 写成常量的话测试只能验证"被节流了"，真正想测的 upsert 分支永远走不到。
 *
 * 局限（写清楚，别假装没有）：进程重启后清零；多实例部署时各算各的。
 * 对我们的量级够用 —— 真要精确得用 Redis。
 */
const DEFAULT_THROTTLE_MS = 60_000;
const lastWriteAt = new Map<string, number>();

function throttleMs(): number {
  const raw = Number(process.env.ERROR_REPORT_THROTTLE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_THROTTLE_MS;
}

function fingerprintOf(event: string, message: string, path: string | undefined): string {
  // message 截前 200 字：后半段常带随机 id/时间戳，会破坏去重
  const raw = `${event}\u0000${message.slice(0, 200)}\u0000${path ?? ''}`;
  return createHash('sha1').update(raw).digest('hex');
}

export async function reportError(input: ReportInput): Promise<void> {
  const { level = 'error', event, message, path, digest } = input;
  const stack = digest ? `${input.stack ?? ''}\n[digest] ${digest}`.trim() : input.stack;

  // ① 无论落库成不成功，现场先进日志
  log.error(event, { err: message, stack, path });

  const fingerprint = fingerprintOf(event, message, path);
  const now = Date.now();
  const last = lastWriteAt.get(fingerprint);
  if (last !== undefined && now - last < throttleMs()) return;
  lastWriteAt.set(fingerprint, now);

  try {
    await prisma.errorLog.upsert({
      where: { fingerprint },
      create: { level, event, message: message.slice(0, 2000), stack, path, fingerprint },
      update: { count: { increment: 1 }, lastSeen: new Date() },
    });
  } catch (error) {
    // 吞掉，但留一条 warn —— 上报管道坏了本身是重要信号
    log.warn('error.report.persist_failed', {
      err: error instanceof Error ? error.message : String(error),
      event,
    });
  }
}

/**
 * 从任意抛出物里取 message / stack。
 * JS 允许 `throw '字符串'` 或 `throw { code: 500 }`，直接 `error.message` 会得到 undefined，
 * 日志里就只剩一个空对象 —— 这个函数的存在就是为了不出现那种日志。
 */
export function describeThrown(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack };
  if (typeof error === 'string') return { message: error };
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: String(error) };
  }
}

/**
 * 服务端兜底：把"任意抛出物"统一成一条上报。
 * route handler 和 Server Action 都 import 这一份，避免各写一个 describeThrown。
 */
export function reportThrown(event: string, path: string, error: unknown): void {
  const { message, stack } = describeThrown(error);
  void reportError({ event, message, stack, path });
}

