import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';

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
