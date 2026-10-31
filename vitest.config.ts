import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * 单测/DB 测试的 runner 配置（E2E 不走这里，走 playwright.config.ts）。
 *
 * 为什么 include 写 `tests/**` 却在跑的时候按目录过滤：
 *   unit 和 db 是两种成本 —— 前者纯函数、10 秒内跑完；后者连真实 Neon、可能要几秒一条。
 *   分成两个 npm 脚本（test:unit / test:db）而不是两个配置文件，
 *   省得维护两份 alias，跑的时候 `vitest run tests/unit` 就是天然的过滤器。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 纯函数测试不该慢：单条超过 10s 就是有东西在偷偷联网
    testTimeout: 10_000,
    // DB 测试要在 test 文件 import @/lib/prisma 之前把 .env.local 读进 process.env
    setupFiles: ['tests/setup-env.ts'],
  },
});
