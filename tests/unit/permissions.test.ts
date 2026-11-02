/**
 * can() 纯函数单测（W20）。
 *
 * 放单测而不是 DB 测试的原因：can() 不碰数据库 —— 这正是它被设计成纯函数的理由之一。
 * 权限矩阵是最容易"改一处破一处"的地方，它必须进 CI 门禁（npm run test 不依赖 DB），
 * 而不是藏在 RUN_DB_TESTS=1 后面。
 */
import { describe, expect, it } from 'vitest';

import { can } from '@/lib/permissions';

const owner = { userId: 'u-owner', role: 'owner' };
const member = { userId: 'u-member', role: 'member' };
const other = 'u-someone-else';

describe('can()：动作级权限矩阵', () => {
  it('kb:delete / kb:rename —— member 只能动自己建的', () => {
    expect(can(member, 'kb:delete', { createdBy: 'u-member' })).toBe(true);
    expect(can(member, 'kb:rename', { createdBy: 'u-member' })).toBe(true);
    expect(can(member, 'kb:delete', { createdBy: other })).toBe(false);
    expect(can(member, 'kb:rename', { createdBy: other })).toBe(false);
  });

  it('kb:delete / kb:rename —— owner 对任何人的库都通', () => {
    expect(can(owner, 'kb:delete', { createdBy: other })).toBe(true);
    expect(can(owner, 'kb:rename', { createdBy: other })).toBe(true);
  });

  it('member 专属动作：邀请与踢人，owner 才有', () => {
    expect(can(member, 'invite:create')).toBe(false);
    expect(can(member, 'member:remove')).toBe(false);
    expect(can(member, 'member:list')).toBe(false);
    expect(can(owner, 'invite:create')).toBe(true);
    expect(can(owner, 'member:remove')).toBe(true);
    expect(can(owner, 'member:list')).toBe(true);
  });

  it('日常动作：组织内全员可做', () => {
    for (const action of [
      'kb:create',
      'document:upload',
      'document:reindex',
      'document:delete',
      'conversation:create',
      'conversation:delete',
    ] as const) {
      expect(can(member, action)).toBe(true);
      expect(can(owner, action)).toBe(true);
    }
  });

  it('未知角色不是 owner（role 来自库，不来自白名单枚举也要挡住）', () => {
    expect(can({ userId: 'u-x', role: 'admin' }, 'member:remove')).toBe(false);
    expect(can({ userId: 'u-x', role: '' }, 'kb:create')).toBe(true); // 日常动作全员
  });

  it('未知动作 fail closed', () => {
    // 故意绕过类型收窄模拟"以后有人加了动作忘了登记 switch"的情形
    const unregistered = 'kb:transfer' as never;
    expect(can(owner, unregistered)).toBe(false);
  });
});
