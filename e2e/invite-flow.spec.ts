import { expect, test } from '@playwright/test';

/**
 * W20 邀请与组织设置的 E2E（单账号能走的完整路径）。
 *
 * 覆盖的是 DB 测试声明够不到的那一层：Server Action 的真实 HTTP 往返、
 * useActionState 的状态回显、<details> 下拉的交互。
 *
 * 消费成功的路径需要第二个 GitHub 账号登录态（W19 D3 同样的理由：外部登录态
 * 进不了稳定复现的范畴），所以"加入"断言的是 **ALREADY_MEMBER**——
 * 这是当前登录用户（组织 owner）点自己组织邀请链接时的正确行为，
 * 且按设计不烧 token，重复跑不会产生脏数据。
 */
test.describe('W20 组织设置与邀请', () => {
  test('设置页渲染：组织可见、owner 区块在、顶栏入口可达', async ({ page }) => {
    await page.goto('/settings');

    await expect(page.getByRole('heading', { name: '组织设置' })).toBeVisible();
    await expect(page.getByText('我所属的组织')).toBeVisible();

    // owner 才有的区块
    await expect(page.getByText('成员（', { exact: false })).toBeVisible();
    await expect(page.getByText('邀请成员')).toBeVisible();
  });

  test('顶栏组织切换器：单组织显示组织名 + 设置入口', async ({ page }) => {
    await page.goto('/kb');

    // 单组织：不渲染下拉，只显示组织名和设置链接（OrgSwitcher 的单组织分支）
    const settingsLink = page.getByRole('link', { name: '设置' });
    await expect(settingsLink).toBeVisible();
    await settingsLink.click();
    await expect(page).toHaveURL(/\/settings/);
  });

  test('生成邀请 → 落地页显示组织名 → 加入（已是成员的正确报错）', async ({ page }) => {
    await page.goto('/settings');

    await page.getByRole('button', { name: '生成邀请链接' }).click();

    // 链接回显在 <code> 里，只显示这一次
    const linkEl = page.locator('code');
    await expect(linkEl).toBeVisible();
    const link = await linkEl.textContent();
    expect(link).toContain('/invite/');

    await page.goto(link!);

    // 落地页：显示组织名与加入按钮（组织名来自库里的邀请记录）
    await expect(page.getByRole('heading', { name: /加入「.+」/ })).toBeVisible();
    await page.getByRole('button', { name: '加入组织' }).click();

    // 当前用户已是该组织成员 → ALREADY_MEMBER，token 不被消费
    await expect(page.getByText('你已经是这个组织的成员')).toBeVisible();
  });

  test('无效 token：落地页明说不可用，不给加入按钮', async ({ page }) => {
    await page.goto('/invite/not-a-real-token-at-all');

    await expect(page.getByRole('heading', { name: '邀请链接不可用' })).toBeVisible();
    await expect(page.getByRole('button', { name: '加入组织' })).toHaveCount(0);
  });
});
