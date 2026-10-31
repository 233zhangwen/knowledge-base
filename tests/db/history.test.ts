/**
 * DB 集成测试：只测「纯函数测不到、又最容易出安全/正确性事故」的那几条。
 *
 * 打真实 Neon，所以：
 *   · 默认 **skip**（不设 RUN_DB_TESTS 就不跑）—— 单测不需要数据库，CI 也不该被网络拖死；
 *   · 自己建临时 user/kb/conversation，afterAll 按 email 前缀清理，不碰既有数据；
 *   · 时间戳显式赋值，不依赖 createdAt 默认值 —— 同一毫秒内插入多行时
 *     排序会不稳定，这种 flaky 在集成测试里最难查。
 *
 * 覆盖的是 W5「历史与隔离」的核心判据：越权提问必须查不到、上下文窗口必须真截断。
 * 这两条一条挂了就是数据泄露/多轮失效，且都不会让 tsc 报错。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ConversationNotFound,
  listConversations,
  loadContext,
  resolveConversation,
} from '@/lib/history';
import { prisma } from '@/lib/prisma';

/** 只有显式设置 RUN_DB_TESTS=1 才连库 */
const RUN_DB_TESTS = Boolean(process.env.RUN_DB_TESTS);

const RUN_ID = `w12test-${Date.now()}`;
const EMAIL_A = `${RUN_ID}-a@example.invalid`;
const EMAIL_B = `${RUN_ID}-b@example.invalid`;

type Fixture = {
  userA: string;
  userB: string;
  kbA: string;
  kbB: string;
  convA: string;
};

describe.skipIf(!RUN_DB_TESTS)('history · 隔离与上下文窗口（真实 Neon）', () => {
  let fx: Fixture;

  beforeAll(async () => {
    const userA = await prisma.user.create({
      data: { email: EMAIL_A, name: '测试用户A' },
      select: { id: true },
    });
    const userB = await prisma.user.create({
      data: { email: EMAIL_B, name: '测试用户B' },
      select: { id: true },
    });
    const kbA = await prisma.knowledgeBase.create({
      data: { name: `${RUN_ID} 库A`, userId: userA.id },
      select: { id: true },
    });
    const kbB = await prisma.knowledgeBase.create({
      data: { name: `${RUN_ID} 库B`, userId: userB.id },
      select: { id: true },
    });
    const convA = await prisma.conversation.create({
      data: { userId: userA.id, kbId: kbA.id, title: 'A 的会话' },
      select: { id: true },
    });

    // 10 条消息 = 5 轮，交替 user/assistant；时间戳显式递增
    const base = Date.now() - 60_000;
    for (let i = 0; i < 10; i++) {
      await prisma.message.create({
        data: {
          conversationId: convA.id,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `消息 ${i + 1}`,
          createdAt: new Date(base + i * 1000),
        },
      });
    }

    fx = { userA: userA.id, userB: userB.id, kbA: kbA.id, kbB: kbB.id, convA: convA.id };
  });

  afterAll(async () => {
    // 按 email 前缀清理：级联删除会带走 kb / conversation / message
    await prisma.user.deleteMany({ where: { email: { in: [EMAIL_A, EMAIL_B] } } });
    await prisma.$disconnect();
  });

  it('B3 · listConversations 只返回本用户本库的会话（换个 userId 就查不到）', async () => {
    const mine = await listConversations(fx.userA, fx.kbA);
    expect(mine.map((c) => c.id)).toContain(fx.convA);

    const others = await listConversations(fx.userB, fx.kbA); // 用户错
    expect(others).toHaveLength(0);

    const wrongKb = await listConversations(fx.userA, fx.kbB); // 库错
    expect(wrongKb).toHaveLength(0);
  });

  it('resolveConversation · 拿别人的会话 id 提问 → ConversationNotFound（不是 403）', async () => {
    await expect(
      resolveConversation({
        userId: fx.userB,
        kbId: fx.kbB,
        conversationId: fx.convA,
        question: '偷看一下',
      }),
    ).rejects.toBeInstanceOf(ConversationNotFound);
  });

  it('resolveConversation · 拿本库会话去问另一个库 → 也拒绝（历史不许串库）', async () => {
    await expect(
      resolveConversation({
        userId: fx.userA,
        kbId: fx.kbB,
        conversationId: fx.convA,
        question: '串库试试',
      }),
    ).rejects.toBeInstanceOf(ConversationNotFound);
  });

  it('resolveConversation · conversationId 为 null 时新建，且标题来自首问', async () => {
    const created = await resolveConversation({
      userId: fx.userA,
      kbId: fx.kbA,
      conversationId: null,
      question: '新会话的第一个问题',
    });
    expect(created.isNew).toBe(true);

    const row = await prisma.conversation.findUnique({
      where: { id: created.id },
      select: { title: true },
    });
    expect(row?.title).toBe('新会话的第一个问题');
  });

  it('loadContext · 只取最近 6 条（HISTORY_TURNS=3 轮）且以 user 开头', async () => {
    const ctx = await loadContext(fx.convA);
    expect(ctx.messages).toHaveLength(6);
    expect(ctx.messages[0].role).toBe('user');
    // 最近 6 条 = 消息 5..10
    expect(ctx.messages[0].content).toBe('消息 5');
    expect(ctx.turn).toBe(5);
  });

  it('loadContext · 历史以 assistant 开头时先丢掉它（畸形上下文会让某些 API 直接报错）', async () => {
    const orphan = await prisma.conversation.create({
      data: { userId: fx.userA, kbId: fx.kbA, title: '孤儿会话' },
      select: { id: true },
    });
    const t = Date.now();
    // 故意造一条"没有问题的回答"在最前面
    await prisma.message.create({
      data: {
        conversationId: orphan.id,
        role: 'assistant',
        content: '我是一条没有对应问题的回答',
        createdAt: new Date(t),
      },
    });
    await prisma.message.create({
      data: {
        conversationId: orphan.id,
        role: 'user',
        content: '后来的问题',
        createdAt: new Date(t + 1000),
      },
    });

    const ctx = await loadContext(orphan.id);
    expect(ctx.messages[0].role).toBe('user');
    expect(ctx.messages[0].content).toBe('后来的问题');
  });
});
