import fs from 'node:fs';

import { Client } from 'pg';
import { expect, test } from '@playwright/test';

/**
 * W21 配额的 E2E（C4 的浏览器侧一半）。
 *
 * 只测浏览器才能证明的事：429 的 JSON error 被 ChatPanel 现成的错误通道
 * 渲染出来（这个通道从 W11 就存在，配额是它的第一个非 200 消费者）。
 * 原子性/口径/重置在 DB 测试（tests/db/quota.test.ts），这里不重复。
 *
 * 做法：把登录用户所在组织的 quota 临时拨成 0（beforeAll），提问必 429；
 * afterAll 恢复 null（= 走 env 默认）。try/finally 语义由 afterAll 保证
 * ——它失败时 Playwright 会报，不会静默吞掉恢复动作。
 */

function directUrl(): string {
  const env = fs.readFileSync('.env.local', 'utf8');
  const m = env.match(/DIRECT_URL="([^"]+)"/) ?? env.match(/DIRECT_URL=(\S+)/);
  if (!m) throw new Error('.env.local 里没有 DIRECT_URL');
  return m[1];
}

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: directUrl(), ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

test.describe.serial('W21 配额超限', () => {
  const touchedOrgIds: string[] = [];

  test.beforeAll(async () => {
    await withClient(async (c) => {
      // 所有组织都拨 0：省去"从 session 反查是哪个用户"的间接层。
      // 这是演示库，组织只有两三个；afterAll 全部恢复 null。
      const orgs = await c.query<{ id: string }>(
        'SELECT id FROM "Organization" WHERE "monthlyAnswerQuota" IS NULL',
      );
      for (const row of orgs.rows) {
        touchedOrgIds.push(row.id);
        await c.query('UPDATE "Organization" SET "monthlyAnswerQuota" = 0 WHERE id = $1', [
          row.id,
        ]);
      }
    });
  });

  test.afterAll(async () => {
    await withClient(async (c) => {
      for (const id of touchedOrgIds) {
        await c.query('UPDATE "Organization" SET "monthlyAnswerQuota" = NULL WHERE id = $1', [id]);
      }
    });
  });

  test('quota=0：提问收到可读的 429 文案，且没有半截回答', async ({ page }) => {
    await page.goto('/kb');
    // 用现有知识库（不新建，省掉上传索引的整段流程——配额检查在检索之前）
    const kbLink = page.getByTestId('kb-link').first();
    await expect(kbLink).toBeVisible();
    await kbLink.click();
    await expect(page).toHaveURL(/\/kb\/[^/?#]+/);

    await page.getByTestId('chat-input').fill('这个问题应该被配额拦住');
    await page.getByTestId('chat-send').click();

    await expect(page.getByTestId('chat-error')).toContainText('本月问答额度已用完', {
      timeout: 20_000,
    });
    await expect(page.getByTestId('message-assistant')).toHaveCount(0);
  });
});
