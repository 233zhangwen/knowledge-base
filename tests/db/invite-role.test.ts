/**
 * DB 集成测试：邀请与角色（W20）。
 *
 * W19 的越权测试全是**行级**的（where 里的 orgId）。W20 引入了两层新东西，
 * 它们的 bug 同样不会报错，但 W19 的测试一条都抓不住：
 *
 *   ① 动作级权限（member 能不能动别人的库）—— 检查点在 can()，不在 where 里
 *   ② 活动组织解析（cookie 是客户端可改的）—— 检查点在 resolveActiveOrg 的 membership 验证
 *
 * 所以这套测试的分工：
 *   - createInvite / consumeInvite / resolveActiveOrg 是**生产代码本身**，直接 import
 *   - can() 是纯函数，放 tests/unit/permissions.test.ts（不需要 DB）
 *   - 删成员的 where 形态测试放在第四节（理由与 W19 相同：Action 依赖请求上下文）
 *
 * 默认 skip，`RUN_DB_TESTS=1 npm run test:db` 才跑。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { consumeInvite, createInvite, hashToken } from '@/lib/invite';
import { resolveActiveOrg } from '@/lib/organization';
import { prisma } from '@/lib/prisma';
import { can } from '@/lib/permissions';

const RUN_DB_TESTS = Boolean(process.env.RUN_DB_TESTS);

const RUN_ID = `w20inv-${Date.now()}`;
const EMAIL_O = `${RUN_ID}-o@example.invalid`; // 组织 owner
const EMAIL_P = `${RUN_ID}-p@example.invalid`; // 受邀者 P
const EMAIL_Q = `${RUN_ID}-q@example.invalid`; // 受邀者 Q（并发消费测试用）
const EMAIL_SOLO = `${RUN_ID}-solo@example.invalid`; // 伪造 cookie 测试：有自己的组织
const EMAIL_NOORG = `${RUN_ID}-noorg@example.invalid`; // 无组织用户（异常路径）

describe.skipIf(!RUN_DB_TESTS)('邀请与角色（W20）', () => {
  let userO: string;
  let userP: string;
  let userQ: string;
  let userSolo: string;
  let userNoOrg: string;
  let orgO: string;
  let orgSolo: string;
  let kbO: string; // owner 建的库（member 不能删/改的对象）
  let kbP: string; // P 自己建的库（member 能删/改的对象）

  beforeAll(async () => {
    const mkUser = async (email: string, name: string) =>
      (
        await prisma.user.create({
          data: { email, name },
          select: { id: true },
        })
      ).id;

    userO = await mkUser(EMAIL_O, '邀请测试O');
    userP = await mkUser(EMAIL_P, '邀请测试P');
    userQ = await mkUser(EMAIL_Q, '邀请测试Q');
    userSolo = await mkUser(EMAIL_SOLO, '邀请测试Solo');
    userNoOrg = await mkUser(EMAIL_NOORG, '邀请测试NoOrg');

    orgO = (
      await prisma.organization.create({
        data: {
          name: `${RUN_ID} 组织O`,
          memberships: { create: { userId: userO, role: 'owner' } },
        },
        select: { id: true },
      })
    ).id;

    orgSolo = (
      await prisma.organization.create({
        data: {
          name: `${RUN_ID} 组织Solo`,
          memberships: { create: { userId: userSolo, role: 'owner' } },
        },
        select: { id: true },
      })
    ).id;

    // NoOrg 用户：故意不建组织，留给 NO_ORGANIZATION 异常路径

    kbO = (
      await prisma.knowledgeBase.create({
        data: { name: `${RUN_ID} owner的库`, orgId: orgO, createdBy: userO },
        select: { id: true },
      })
    ).id;
    kbP = (
      await prisma.knowledgeBase.create({
        data: { name: `${RUN_ID} P的库`, orgId: orgO, createdBy: userP },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    // 删 org 级联带走 kb/invite；Invite 挂在 orgO 上，一起走
    await prisma.organization.deleteMany({ where: { name: { startsWith: RUN_ID } } });
    await prisma.user.deleteMany({
      where: { email: { startsWith: RUN_ID } },
    });
    await prisma.$disconnect();
  });

  // ------------------------------------------------------------
  // 一、邀请生成与 hash 落库（C1）
  // ------------------------------------------------------------
  describe('生成邀请', () => {
    it('库里只有 hash，明文 token 查不到（C1）', async () => {
      const { token } = await createInvite({ orgId: orgO, createdBy: userO });

      const byPlaintext = await prisma.invite.findFirst({
        where: { tokenHash: token },
        select: { id: true },
      });
      expect(byPlaintext).toBeNull();

      const byHash = await prisma.invite.findFirst({
        where: { tokenHash: hashToken(token) },
        select: { id: true, role: true },
      });
      expect(byHash).not.toBeNull();
      expect(byHash!.role).toBe('member');
    });
  });

  // ------------------------------------------------------------
  // 二、消费流程（C2）
  // ------------------------------------------------------------
  describe('消费邀请', () => {
    /** 每条消费用例用全新的受邀请者：一旦某条用例消费成功，该用户就成了成员，
     *  复用他会命中 ALREADY_MEMBER（行为正确，测试却会误判）。 */
    let inviteeSeq = 0;
    const mkInvitee = async () => {
      inviteeSeq += 1;
      const email = `${RUN_ID}-inv${inviteeSeq}@example.invalid`;
      return (
        await prisma.user.create({
          data: { email, name: `邀请测试Inv${inviteeSeq}` },
          select: { id: true },
        })
      ).id;
    };

    it('正常消费：加入组织，role 来自库里的邀请（不是来自链接）', async () => {
      const { token } = await createInvite({ orgId: orgO, createdBy: userO });

      const result = await consumeInvite(token, userP);
      expect(result.ok).toBe(true);

      const membership = await prisma.membership.findUnique({
        where: { userId_orgId: { userId: userP, orgId: orgO } },
        select: { role: true },
      });
      expect(membership?.role).toBe('member');
    });

    it('同一 token 第二次消费 → USED，不再产生第二条成员记录', async () => {
      const u1 = await mkInvitee();
      const u2 = await mkInvitee();
      const { token } = await createInvite({ orgId: orgO, createdBy: userO });

      const first = await consumeInvite(token, u1);
      expect(first.ok).toBe(true);

      const second = await consumeInvite(token, u2);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.reason).toBe('USED');

      const rows = await prisma.invite.findFirst({
        where: { tokenHash: hashToken(token) },
        select: { consumedBy: true },
      });
      expect(rows?.consumedBy).toBe(u1);
    });

    it('并发消费同一 token：恰好一个成功（条件式原子消费，不是先查后改）', async () => {
      const u1 = await mkInvitee();
      const u2 = await mkInvitee();
      const { token } = await createInvite({ orgId: orgO, createdBy: userO });

      const [r1, r2] = await Promise.all([
        consumeInvite(token, u1),
        consumeInvite(token, u2),
      ]);

      const oks = [r1, r2].filter((r) => r.ok);
      expect(oks).toHaveLength(1);
    });

    it('过期 token → EXPIRED', async () => {
      const { token } = await createInvite({ orgId: orgO, createdBy: userO });
      // 直接把库里的过期时间拨回过去（不走时间旅行库，测试数据自己负责）
      await prisma.invite.updateMany({
        where: { tokenHash: hashToken(token) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const result = await consumeInvite(token, userP);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('EXPIRED');
    });

    it('假 token → INVALID（不抛异常，返回可判断的结果）', async () => {
      const result = await consumeInvite('totally-made-up-token', userP);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('INVALID');
    });

    it('已是成员的人消费 → ALREADY_MEMBER，且 token 不被烧掉', async () => {
      const { token } = await createInvite({ orgId: orgO, createdBy: userO });

      // O 是 orgO 的 owner，消费自己组织的邀请
      const self = await consumeInvite(token, userO);
      expect(self.ok).toBe(false);
      if (!self.ok) expect(self.reason).toBe('ALREADY_MEMBER');

      // token 没被烧：一个全新用户之后仍然能正常用
      const fresh = await mkInvitee();
      const after = await consumeInvite(token, fresh);
      expect(after.ok).toBe(true);
    });
  });

  // ------------------------------------------------------------
  // 三、动作级权限矩阵（C3，真代码 can() + 真实资源）
  // ------------------------------------------------------------
  describe('角色矩阵', () => {
    it('member 不能删/改别人建的库，能删/改自己的', () => {
      const p = { userId: userP, role: 'member' };
      expect(can(p, 'kb:delete', { createdBy: userO })).toBe(false);
      expect(can(p, 'kb:rename', { createdBy: userO })).toBe(false);
      expect(can(p, 'kb:delete', { createdBy: userP })).toBe(true);
      expect(can(p, 'kb:rename', { createdBy: userP })).toBe(true);
    });

    it('owner 对任何库全通', () => {
      const o = { userId: userO, role: 'owner' };
      expect(can(o, 'kb:delete', { createdBy: userP })).toBe(true);
      expect(can(o, 'kb:rename', { createdBy: userP })).toBe(true);
    });

    it('邀请与踢人是 owner 专属', () => {
      expect(can({ userId: userP, role: 'member' }, 'invite:create')).toBe(false);
      expect(can({ userId: userP, role: 'member' }, 'member:remove')).toBe(false);
      expect(can({ userId: userO, role: 'owner' }, 'invite:create')).toBe(true);
      expect(can({ userId: userO, role: 'owner' }, 'member:remove')).toBe(true);
    });

    it('日常动作全员可做', () => {
      const p = { userId: userP, role: 'member' };
      expect(can(p, 'kb:create')).toBe(true);
      expect(can(p, 'document:upload')).toBe(true);
      expect(can(p, 'conversation:delete')).toBe(true);
    });

    it('未知动作 fail closed：宁可拒绝，不可放行', () => {
      const p = { userId: userO, role: 'owner' };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(can(p, 'kb:take-over' as any)).toBe(false);
    });
  });

  // ------------------------------------------------------------
  // 四、活动组织解析（C4，真代码 resolveActiveOrg）
  // ------------------------------------------------------------
  describe('resolveActiveOrg', () => {
    it('cookie 指向自己的组织 → 原样采用', async () => {
      const result = await resolveActiveOrg(userO, orgO);
      expect(result.orgId).toBe(orgO);
      expect(result.role).toBe('owner');
    });

    it('cookie 伪造（指向自己不是成员的组织）→ fallback 最早组织，不越权（C4）', async () => {
      // Solo 用户把 cookie 改成 orgO —— membership 查不到，必须 fallback
      const result = await resolveActiveOrg(userSolo, orgO);
      expect(result.orgId).toBe(orgSolo);
      expect(result.orgId).not.toBe(orgO);
    });

    it('无 cookie → fallback 最早加入的组织', async () => {
      const result = await resolveActiveOrg(userO, undefined);
      expect(result.orgId).toBe(orgO);
    });

    it('被移出组织后（且没有别的组织）：旧 cookie 失效，抛 NO_ORGANIZATION 由上层兜底', async () => {
      // Q 加入 orgO（复用一条新邀请），然后被移除
      const { token } = await createInvite({ orgId: orgO, createdBy: userO });
      await consumeInvite(token, userQ);
      const qMembership = await prisma.membership.findUnique({
        where: { userId_orgId: { userId: userQ, orgId: orgO } },
        select: { id: true },
      });
      expect(qMembership).not.toBeNull();

      await prisma.membership.delete({ where: { id: qMembership!.id } });

      // Q 手里的旧 cookie 还指着 orgO —— membership 查不到；
      // fallback 也没有任何组织可落（测试里 Q 没登录过，没触发过 ensureOrganization）
      // → 抛 NO_ORGANIZATION，由 requireTenant 的 ensureOrganization 兜底建个人空间。
      // 这条不是"失败路径"，它是上层兜底逻辑的契约。
      await expect(resolveActiveOrg(userQ, orgO)).rejects.toThrow('NO_ORGANIZATION');
    });

    it('被移出后有别的组织 → cookie 失效落到自己的组织（完整 fallback 场景）', async () => {
      // 给 Q 建一个自己的组织（模拟他本来就有个人空间）
      const orgQ = (
        await prisma.organization.create({
          data: {
            name: `${RUN_ID} 组织Q`,
            memberships: { create: { userId: userQ, role: 'owner' } },
          },
          select: { id: true },
        })
      ).id;

      // Q 被 orgO 移除（上一条已经移过了，直接验证 cookie 行为）
      const stillMember = await prisma.membership.findUnique({
        where: { userId_orgId: { userId: userQ, orgId: orgO } },
        select: { id: true },
      });
      expect(stillMember).toBeNull();

      const result = await resolveActiveOrg(userQ, orgO);
      expect(result.orgId).toBe(orgQ);
      expect(result.role).toBe('owner');
    });

    it('没有任何 membership → NO_ORGANIZATION（requireTenant 负责兜底建组织）', async () => {
      await expect(resolveActiveOrg(userNoOrg, undefined)).rejects.toThrow('NO_ORGANIZATION');
    });
  });

  // ------------------------------------------------------------
  // 五、移除成员的 where 形态（与 W19 第四节同理由：Action 依赖请求上下文）
  // ------------------------------------------------------------
  describe('移除成员', () => {
    it('按 membershipId + orgId 查目标：别的组织的成员查不到', async () => {
      // 造一个别的组织的成员，试图用它的 membership id 从 orgO 移除
      const outsider = await prisma.membership.findUnique({
        where: { userId_orgId: { userId: userSolo, orgId: orgSolo } },
        select: { id: true },
      });

      const target = await prisma.membership.findFirst({
        where: { id: outsider!.id, orgId: orgO },
        select: { id: true },
      });
      expect(target).toBeNull();
    });

    it('删除后成员记录消失（正常路径）', async () => {
      const { token } = await createInvite({ orgId: orgO, createdBy: userO });
      await consumeInvite(token, userQ);

      const qMembership = await prisma.membership.findUnique({
        where: { userId_orgId: { userId: userQ, orgId: orgO } },
        select: { id: true },
      });
      expect(qMembership).not.toBeNull();

      await prisma.membership.delete({ where: { id: qMembership!.id } });

      const gone = await prisma.membership.findUnique({
        where: { userId_orgId: { userId: userQ, orgId: orgO } },
        select: { id: true },
      });
      expect(gone).toBeNull();
    });
  });
});
