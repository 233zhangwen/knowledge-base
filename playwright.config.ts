import { defineConfig, devices } from '@playwright/test';

/**
 * E2E 配置（W12 C 组）。
 *
 * 几个刻意的选择：
 *   · workers: 1 + fullyParallel: false —— 三条链路共用一个知识库、一套会话，
 *     并行跑会互相踩（A 删掉了 B 正要断言的那条会话）。E2E 的价值在"稳"，不在快。
 *   · trace: 'on-first-retry' —— 只在失败后重试时录 trace，平时不拖慢；
 *     失败时 `npx playwright show-trace` 能一帧一帧看当时 DOM 长什么样。
 *   · reuseExistingServer: true —— 你自己 dev server 开着的时候不要另起一个抢 3000 端口。
 *   · storageState —— 登录态复用（决策①）：GitHub OAuth 无法自动化，改成
 *     `npm run e2e:auth` 手工登一次、把 cookie 存下来，之后所有用例带同一份。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000, // 流式回答 + 索引，单条给足
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    storageState: 'e2e/.auth/state.json',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      // 1280 宽 = lg 断点以上，侧栏走"竖列常开"形态（窄屏浮层另有交互，E2E 不测它）
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    // 首次启动要编译，给足时间；超时说明 dev server 本身有问题
    timeout: 180_000,
  },
});
