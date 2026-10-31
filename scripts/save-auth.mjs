/**
 * 一次性生成 E2E 登录态：`npm run e2e:auth`
 *
 * 为什么需要它（W12 决策①）：
 *   GitHub OAuth 的授权页带验证码/二次确认，自动化过不去。
 *   所以在生产代码里开后门（加测试专用 provider）和"手工登一次存 cookie"之间，
 *   选了后者 —— 少一处生产代码的例外，代价只是 cookie 过期时重跑一次这个脚本。
 *
 * 用起来是这样：
 *   1. 脚本弹出真实浏览器，停到 /login；
 *   2. 你自己点"用 GitHub 登录"完成授权；
 *   3. 脚本等到页面回到 /kb 就自动存 cookie 并退出（**不需要在终端按回车**，
 *      非交互终端按回车会卡死，所以用 URL 变化当信号）。
 *
 * ⚠️ 产物 e2e/.auth/state.json 是**真凭证**（AUTH_SECRET 加密的会话 cookie），
 *    已在 .gitignore 里；不要发给任何人，也不要贴进 issue。
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const OUT_DIR = path.join('e2e', '.auth');
const OUT_FILE = path.join(OUT_DIR, 'state.json');

// 这个脚本不像 test:e2e 那样会自己拉起 dev server（Playwright webServer 只管测试进程），
// 它默认 3000 端口上已经有服务。先探一下，别让人对着半屏堆栈猜原因。
try {
  await fetch(BASE_URL, { signal: AbortSignal.timeout(3000) });
} catch {
  console.error(`❌ ${BASE_URL} 连不上 —— dev server 没开。`);
  console.error('   先在另一个终端跑 npm run dev，等它打印 Ready，再回来跑本命令。');
  process.exit(1);
}

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

console.log(`打开 ${BASE_URL}/login —— 请在弹出的浏览器里完成 GitHub 登录（5 分钟内有效）`);
await page.goto(`${BASE_URL}/login`);

try {
  // 登录成功后 proxy 会把人放到 /kb；这就是"登好了"的信号
  await page.waitForURL('**/kb', { timeout: 5 * 60_000 });
  await mkdir(OUT_DIR, { recursive: true });
  await context.storageState({ path: OUT_FILE });
  console.log(`✅ 登录态已保存到 ${OUT_FILE}（已 gitignore，别外传）`);
} catch (error) {
  console.error(`❌ 没等到登录完成：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
