/**
 * 三条核心链路的 E2E（W12 C 组）。
 *
 * 为什么只有三条：
 *   E2E 的成本是"每次跑都要起服务、等编译、等 LLM"，所以只测**只有真实浏览器才能证明**的事：
 *   服务端渲染出来的界面、流式协议在前端的解析、Server Action 之后的页面状态。
 *   纯逻辑一律留给 unit（tests/unit），别在这里测"17 天"这种能单测的字符串。
 *
 * 断言纪律：
 *   · 只用 data-testid，不用文案 —— 改一次文案不该让测试全红；
 *   · 不用 waitForTimeout —— 它只是把 flaky 变慢，解决不了"元素还没挂上"；
 *   · 等"结果出现"而不是等"时间过去"。
 *
 * 副作用：会留下一个名为 `E2E 知识库 <随机后缀>` 的知识库（含 1 个文档、2 个会话）。
 * 前缀就是给人看的标记，跑几次之后在页面上删掉即可。
 */
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const RUN_ID = Date.now().toString(36);
const KB_NAME = `E2E 知识库 ${RUN_ID}`;
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'e2e-sample.md');

/** 建库后的详情页 URL，三条用例共用（serial 保证顺序） */
let kbUrl = '';

/**
 * 等文档索引完成。
 *
 * 为什么是"重载轮询"而不是等前端推送：索引在 Server Action 里异步跑完才 revalidate，
 * 期间页面不会自己变。E2E 里最稳的做法就是周期性 reload 看状态位。
 */
async function waitForDocumentReady(page: Page) {
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('doc-status').first()).toHaveAttribute('data-status', 'ready');
  }).toPass({ timeout: 90_000, intervals: [2_000] });
}

test.describe.serial('知识库核心链路', () => {
  test('链路 1：建库 → 上传 → 提问 → 引用可见', async ({ page }) => {
    await page.goto('/kb');
    await page.getByTestId('kb-name-input').fill(KB_NAME);
    await page.getByTestId('kb-create-submit').click();

    const kbLink = page.getByTestId('kb-link').filter({ hasText: KB_NAME });
    await expect(kbLink).toBeVisible();
    await kbLink.click();
    kbUrl = page.url();

    await page.getByTestId('file-input').setInputFiles(FIXTURE_PATH);
    await page.getByTestId('upload-submit').click();
    await waitForDocumentReady(page);

    await page.getByTestId('chat-input').fill('正式员工年假有多少天？');
    await page.getByTestId('chat-send').click();

    // 流式结束后答案里必须带引用编号 —— 这是 RAG 与"纯聊天"的分界线
    const answer = page.getByTestId('message-assistant').last();
    await expect(answer).toContainText('[1]', { timeout: 60_000 });
    await expect(page.getByTestId('citations-summary').last()).toBeVisible();
  });

  test('链路 2：闲聊不检索、不产生引用（W11 B2 的自动化版本）', async ({ page }) => {
    await page.goto(kbUrl);
    await page.getByTestId('new-conversation').click();
    // 新对话会带 ?n= 导航，等 URL 稳定再操作
    await expect(page).toHaveURL(/n=\d+/);

    await page.getByTestId('chat-input').fill('你好');
    await page.getByTestId('chat-send').click();

    // 流结束的标志：发送按钮回来（生成中它是"停止生成"）
    await expect(page.getByTestId('chat-send')).toBeVisible({ timeout: 60_000 });

    const answer = page.getByTestId('message-assistant').last();
    await expect(answer).not.toHaveText('');
    await expect(page.getByTestId('citations-summary')).toHaveCount(0);
    await expect(answer).not.toContainText(/\[\d+\]/);
  });

  test('链路 3：会话出现在历史侧栏 → 两步确认后删除', async ({ page }) => {
    await page.goto(kbUrl);

    const links = page.getByTestId('conversation-link');
    await expect(links.first()).toBeVisible();
    const before = await links.count();
    expect(before).toBeGreaterThan(0);

    // 删除图标是 hover 才浮现（opacity + pointer-events 成对切换），必须先 hover 行
    await links.first().hover();
    await page.getByTestId('delete-conversation').first().click();
    await page.getByTestId('delete-conversation-confirm').first().click();

    await expect(links).toHaveCount(before - 1);
  });
});
