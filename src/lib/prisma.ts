import { PrismaPg } from '@prisma/adapter-pg';
/**
 * 用**相对路径**而不是 `@/generated/prisma/client`（同目录别的文件都用别名，这里是例外）。
 *
 * 原因是评测脚本（`scripts/eval-agent.mts`）要 `import { retrieve } from '../src/lib/retrieve.ts'`
 * 直接跑真代码，而 Node 的 `--experimental-strip-types` **不解析 tsconfig 的 paths**。
 * 只要这条依赖链上有一个 `@/`，整条链就跑不起来，脚本就只能再抄一份 SQL ——
 * 那正是 W16 A0 要消灭的漂移源（手抄副本漏了 rerank 和围栏，评测了半年的假系统）。
 *
 * 别为了"风格统一"改回别名：改了就等于把评测重新推回手抄时代。
 */
import { PrismaClient } from '../generated/prisma/client';

/**
 * Prisma 7 的变化：PrismaClient 不再内置连接池，
 * 必须显式传一个 driver adapter（这里是 postgres → @prisma/adapter-pg）。
 * 不传会直接报：PrismaClientConstructorValidationError。
 */
function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('缺少环境变量 DATABASE_URL，检查 .env.local 是否配置');
  }

  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
}

/**
 * 为什么要挂到 globalThis：
 * 开发模式下 Next 热更新会反复执行这个模块，
 * 每次都 new PrismaClient() 会不断新建连接池，
 * 跑一会儿 Neon 的连接数就被吃光，报 "too many connections"。
 */
const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof createPrismaClient>;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
