/**
 * 会话标题：取首问前 20 个字，超长截断加省略号。
 *
 * 为什么单独一个文件（W13 修的一个真 bug）：
 *   它原本住在 history.ts 里，而 history.ts 顶层 `import { prisma }` 并在模块求值时
 *   构造 Prisma client（Prisma 7 要显式传 driver adapter，所以必须在 import 时就拿到
 *   DATABASE_URL）。结果 tests/unit 里为了测这个**纯函数**，被迫把整个数据库连接也拉进来：
 *   本地有 .env.local 看不出来，CI 干净检出直接 `缺少环境变量 DATABASE_URL` 崩掉。
 *
 * 由此得到的规则：**纯函数不要和"模块求值就产生副作用"的模块放在一起**。
 * 判断标准很简单 —— 这个函数能不能在没有任何环境变量的机器上跑？能，就别让它沾 db。
 */
const TITLE_LENGTH = 20;

export function titleFromQuestion(question: string): string {
  // 侧栏是一行布局：换行、连续空白都必须压平，否则标题会变成两行或被撑破
  const flat = question.replace(/\s+/g, ' ').trim();
  return flat.length > TITLE_LENGTH ? `${flat.slice(0, TITLE_LENGTH)}…` : flat;
}
