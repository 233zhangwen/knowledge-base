/**
 * 结构化日志（W13 B 组）。
 *
 * 为什么不继续用裸 console.log：
 *   现在 14 处日志是给人读的中文串，`[agent] conv=abc123 完成：steps=3 tokens=1200/830`。
 *   人读没问题，但线上排查要的是"把所有 kb=xxx 的失败捞出来""P95 延迟多少"，
 *   这些在字符串里只能靠肉眼和正则 —— 而平台日志只能按行搜。
 *
 * 输出形态：**单行 JSON**
 *   {"t":"2026-10-31T09:00:00.000Z","lvl":"info","evt":"agent.turn.done","convId":"abc12345","steps":3}
 *   一行一条 = 平台按行收集时不串行；JSON = 平台能按字段过滤。
 *
 * 纪律（这几条比实现本身重要）：
 *   1. **事件名点分**：`模块.动作`，如 `agent.turn.start`、`llm.thinking_tokens`。
 *      事件名是查询的入口，改名字等于把历史日志切断 —— 想清楚再起名。
 *   2. **字段值只放已经是标量的东西**：id、数量、耗时、布尔。
 *      用户输入（问题正文、文档内容）**不进日志** —— 日志会被转发、被截图、被贴进 issue。
 *      要看长度和指纹用 previewText()。
 *   3. **错误对象要拆开**：`err` 放 message，`stack` 单独放，别把 Error 塞进 JSON.stringify
 *      （默认序列化出来是 `{}`，这是最常见的"日志里什么都没有"事故）。
 */

import { createHash } from 'node:crypto';

type Level = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 日志里绝不能出现的字段名（值一律替换成 [redacted]） */
const SENSITIVE_KEY = /(apikey|api_key|secret|password|authorization|cookie|database_?url|token$)/i;

/**
 * 阈值每次读环境变量而不是模块加载时读一次：
 * 单测里要能临时改 LOG_LEVEL 验证分级（B3 反证），模块级常量做不到。
 */
function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  const level = (['debug', 'info', 'warn', 'error'] as const).find((l) => l === raw);
  return RANK[level ?? 'info'];
}

function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (SENSITIVE_KEY.test(key)) {
      out[key] = '[redacted]';
    } else if (value instanceof Error) {
      // 兜底：调用方本该用 err: e.message + stack: e.stack，但忘了也不至于丢信息
      out.err = value.message;
      out.stack = value.stack;
    } else if (typeof value === 'string' && value.length > 200) {
      // 长字符串几乎一定是正文类内容，截断 —— 日志行太长会被平台折叠
      out[key] = `${value.slice(0, 200)}…(${value.length})`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function emit(level: Level, event: string, fields: Record<string, unknown> = {}) {
  if (RANK[level] < threshold()) return;

  const line = JSON.stringify({
    t: new Date().toISOString(),
    lvl: level,
    evt: event,
    ...sanitize(fields),
  });

  // 按级别挑 console 方法：Netlify / 容器运行时按 stderr 区分 error 流
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit('debug', event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit('error', event, fields),
};

/**
 * 用户输入的可记录替代品：长度 + 前 8 位 sha1。
 *
 * 为什么不是明文：日志的访问面比数据库大得多（平台后台、转发、日志平台成员）。
 * 指纹的用处：同一个问题反复失败时能在日志里对上是"同一个问题"，
 * 而不需要看到问题本身。
 */
export function previewText(text: string): string {
  const hash = createHash('sha1').update(text).digest('hex').slice(0, 8);
  return `${text.length}字#${hash}`;
}

/** 毫秒耗时，统一取整；散落的 Date.now()-t0 容易有人忘了算 */
export function msSince(startedAt: number): number {
  return Date.now() - startedAt;
}
