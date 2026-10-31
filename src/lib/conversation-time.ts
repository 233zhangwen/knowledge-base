/**
 * 会话列表的「相对时间 + 分组标签」。
 *
 * 从 page.tsx 里抽出来的（W12 A4）：抽出来才能被单测打中 ——
 * 这段逻辑有 4 个分支（今天 / 昨天 / 今年内 / 跨年），
 * 而且**改坏了不会报错**，只会让分组头写错几天，属于典型的"必须靠测试盯"的代码。
 *
 * 两个参数都是显式的 now：不在函数里 new Date()。
 * 理由有二 ——
 *   1. 服务端算完字符串再传下去，避免 hydration 时客户端时钟不同导致警告；
 *   2. 测试要能构造"跨年边界""零点前后"这种时刻，靠注入 now 才测得动。
 */

export type ConversationTimeParts = {
  /** 单条会话右侧显示的相对时间：今天 / 昨天 / 10 月 27 日 / 2025 年 12 月 31 日 */
  timeText: string;
  /** 分组头标签，与 timeText 同源（同一天必同标签），可以直接当 Map 的 key */
  group: string;
};

export function conversationTimeParts(updatedAt: Date, now: Date): ConversationTimeParts {
  const diffDays = Math.round((startOfDay(now) - startOfDay(updatedAt)) / 86_400_000);

  // <= 0 兜住"未来时间"（时钟漂移、数据库时区错配都可能产生），当成今天
  if (diffDays <= 0) return { timeText: '今天', group: '今天' };
  if (diffDays === 1) return { timeText: '昨天', group: '昨天' };

  const md = `${updatedAt.getMonth() + 1} 月 ${updatedAt.getDate()} 日`;
  if (updatedAt.getFullYear() === now.getFullYear()) return { timeText: md, group: md };

  const full = `${updatedAt.getFullYear()} 年 ${md}`;
  return { timeText: full, group: full };
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
