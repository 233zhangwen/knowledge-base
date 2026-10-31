/**
 * vitest 的全局 setup：只做一件事 —— 把 .env.local 读进 process.env。
 *
 * 为什么需要它：
 *   Next 自己会加载 .env.local，但 vitest 不会。DB 集成测试要 import `@/lib/prisma`，
 *   而那个单例在**模块求值时**就要 DATABASE_URL（Prisma 7 的 driver adapter 是显式传的），
 *   所以必须在任何 test 文件被 import 之前完成加载 —— setupFiles 正是这个时机。
 *
 * 用 Node 自带的 process.loadEnvFile（Node 20.12+）而不是装 dotenv：
 *   一个 .env 文件不值得再引一个依赖，而且这样保持"只有 prisma7.config.ts 会读 env"
 *   的假象被打破时，读者能一眼看到还有第二个地方在读 env（这是好事，藏起来才是坑）。
 *
 * 注意：文件不存在时**不能抛错** —— 纯函数单测（test:unit）根本不需要 env，
 * 在没有 .env.local 的机器上（比如 CI 里只跑单测）也必须能跑。
 */
import { existsSync } from 'node:fs';

const ENV_FILE = '.env.local';

if (existsSync(ENV_FILE)) {
  try {
    // loadEnvFile 不会覆盖已存在的 process.env 键（与 Next 的优先级一致：真实环境变量优先）
    process.loadEnvFile?.(ENV_FILE);
  } catch {
    // 解析失败不应该让单测陪葬：DB 测试自己会因为缺 DATABASE_URL 而 skip
  }
}
