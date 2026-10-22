// Prisma 7 配置文件（旧版里 schema.prisma 的 url / directUrl 搬到了这里）
//
// 为什么要分两个地址：
//   url       = pooled 连接池地址 —— 应用运行时用，能扛住并发连接
//   directUrl = 直连地址         —— prisma migrate 用它，因为迁移需要独占连接
//
// 注意：这里读的是 .env.local（Next.js 的约定），不是 prisma init 默认生成的 .env，
// 所以显式指定 path，并且用 override 保证不会被系统环境变量盖掉。

import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

config({ path: '.env.local', override: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'] ?? '',
    directUrl: process.env['DIRECT_URL'] ?? '',
  },
});
