/**
 * DB 集成测试：配额与用量（W21）。
 *
 * 核心判据是 C2 的**并发原子性**：quota=3 起 5 个并发，恰好 3 个成功。
 * 这正是"读-改-写不是一步"的实证 —— 如果 consumeMonthlyQuestion 里去掉
 * FOR UPDATE 锁组织行，这条测试会间歇性放出 4~5 个成功（本地连接池下
 * 撞上的概率不低，这也是它能留在 DB 测试而不是单测里的原因）。
 *
 * 口径提醒（spec D1/D2）：已用量 = 本月 user 消息数，现算，不存累计字段。
 * 这些测试同时就是对账测试：占用成功几个，count 就必须是几个。
 *
 * 默认 skip，`RUN_DB_TESTS=1 npm run test:db` 才跑。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/prisma';
import {
  consumeMonthlyQuestion,
  countMonthlyQuestions,
  QuotaExceeded,
  resolveMonthlyQuota,
} from '@/lib/quota';

const RUN_DB_TESTS = Boolean(process.env.RUN_DB_TESTS);

const RUN_ID = `w21quota-${Date.now()}`;

describe.skipIf(!RUN_DB_TESTS)('配额与用量（W21）', () => {
  let orgId: string;
  let conversationId: string;
  let ownerId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `${RUN_ID}@example.invalid`, name: '配额测试' },
      select: { id: true },
    });
    ownerId = user.id;

    const org = await prisma.organization.create({
      data: {
        name: `${RUN_ID} 组织`,
        monthlyAnswerQuota: null, // 默认先走 env/兜底值
        memberships: { create: { userId: user.id, role: 'owner' } },
      },
      select: { id: true },
    });
    orgId = org.id;

    const kb = await prisma.knowledgeBase.create({
      data: { name: `${RUN_ID} 库`, orgId, createdBy: user.id },
      select: { id: true },
    });
    const conv = await prisma.conversation.create({
      data: { orgId, createdBy: user.id, kbId: kb.id, title: '配额测试会话' },
      select: { id: true },
    });
    conversationId = conv.id;
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { name: { startsWith: RUN_ID } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: RUN_ID } } });
    await prisma.$disconnect();
  });

  it('null 配额走默认值：DB 字段为 null，resolveMonthlyQuota 给出正数兜底', async () => {
    const field = await prisma.organization
      .findUnique({ where: { id: orgId }, select: { monthlyAnswerQuota: true } })
      .then((o) => o?.monthlyAnswerQuota);
    expect(field).toBeNull();

    const limit = await resolveMonthlyQuota(orgId);
    expect(limit).toBeGreaterThan(0);
    await expect(countMonthlyQuestions(orgId)).resolves.toBe(0);
  });

  it('C2 原子性：quota=3 起 5 个并发，恰好 3 个成功（C2）', async () => {
    await prisma.organization.update({
      where: { id: orgId },
      data: { monthlyAnswerQuota: 3 },
    });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        consumeMonthlyQuestion({
          orgId,
          conversationId,
          content: `并发问题 #${i}`,
        }),
      ),
    );

    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(ok).toHaveLength(3);
    // 5 - 3 = 2。这条注释是留给下一个人的：本文第一版把这里写成了 3，
    // 产品代码被冤枉了三轮排查（原生 pg 实验、Prisma 事务探针全做过）才回到判据本身。
    expect(rejected).toHaveLength(2);
    // 全部因配额拒绝，不是别的异常
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(QuotaExceeded);
    }
  });

  it('C3 口径对账：成功 3 个，本月 user 消息数恰好 3；拒绝的没落库（C3/C4）', async () => {
    const used = await countMonthlyQuestions(orgId);
    expect(used).toBe(3);

    const messages = await prisma.message.findMany({
      where: { conversation: { orgId }, role: 'user' },
      select: { content: true },
    });
    expect(messages).toHaveLength(3);
    expect(messages.every((m) => m.content.startsWith('并发问题'))).toBe(true);
  });

  it('C3 超限后的错误带 used/limit，供 429 文案拼装', async () => {
    await consumeMonthlyQuestion({ orgId, conversationId, content: '第 4 问，应被拒' }).catch(
      (e) => {
        expect(e).toBeInstanceOf(QuotaExceeded);
        expect((e as QuotaExceeded).used).toBe(3);
        expect((e as QuotaExceeded).limit).toBe(3);
      },
    );
  });

  it('C5 月初重置：把已有消息拨到上月，额度立刻恢复（C5）', async () => {
    // 当前 used=3 / limit=3，必拒
    const full = consumeMonthlyQuestion({ orgId, conversationId, content: '满员之问' });
    await expect(full).rejects.toBeInstanceOf(QuotaExceeded);

    // 把 3 条消息拨到上月 → 本月 used=0 → 同样的配额立刻放行
    await prisma.message.updateMany({
      where: { conversation: { orgId }, role: 'user' },
      data: { createdAt: new Date(Date.now() - 40 * 24 * 3600 * 1000) },
    });
    await expect(
      consumeMonthlyQuestion({ orgId, conversationId, content: '重置后第一问' }),
    ).resolves.toBeUndefined();
    await expect(countMonthlyQuestions(orgId)).resolves.toBe(1);
  });
});
