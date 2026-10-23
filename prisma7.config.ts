// Prisma 7 配置文件（旧版里 schema.prisma 的 url / directUrl 搬到了这里）
//
// 这个配置只服务于 Prisma CLI（migrate / studio / generate），不参与应用运行时。
// 所以用 DIRECT_URL（直连）而不是 DATABASE_URL（连接池）：
//   - 迁移要加 advisory lock、改表结构，直连更稳，不会被 pooler 的连接复用干扰
//   - CLI 是偶尔跑一次的操作，不需要连接池扛并发
// 应用运行时的地址在 src/lib/prisma.ts 里单独读 DATABASE_URL，两边职责分开。
//
// 注意：这里读的是 .env.local（Next.js 的约定），不是 prisma init 默认生成的 .env，
// 所以显式指定 path，并且用 override 保证不会被系统环境变量盖掉。
//
// Prisma 7 起 datasource 只认 url / shadowDatabaseUrl，directUrl 已被删除。

import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

config({ path: '.env.local', override: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DIRECT_URL'] ?? '',
  },
});
