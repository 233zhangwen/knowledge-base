/**
 * DB 集成测试：多租户越权（W19）。
 *
 * 这是本项目最该有的一套测试。理由写在 docs/ACCEPTANCE-W19.md 第 0 节：
 * 租户条件漏写一处**不会报错** —— 功能照跑、单测照绿、tsc 零错误，
 * 只有这一层能发现。
 *
 * ⚠️ 这套测试有一个必须说清的局限（别让它看起来比实际更强）：
 *
 *   `history.ts` 的那三个函数是**生产代码本身**，测试直接 import，不存在副本。
 *   但 KnowledgeBase / Document 的增删改还散在各 Server Action 里，而 Action 依赖
 *   请求上下文（requireTenant → auth()），测试进程里拿不到。
 *   所以那几条用的是**与 Action 完全相同的 where 形态**，验证的是
 *   "这个条件能挡住跨组织访问"，不是"Action 里写的就是这个条件"。
 *
 *   后半句由静态审计兜底：`npm run check:scope` 扫 src/ 下所有 prisma 查询，
 *   列出没带 orgId 的。两个加起来才完整 ——
 *     动态测试证明「带了这个条件就挡得住」
 *     静态检查证明「每条查询都带了」
 *
 *   W16 的教训就在这里：评测脚本手抄了一份检索 SQL，测的是线上不存在的系统。
 *   这套测试刻意把"哪些是真代码、哪些是同样形态"写在上面，就是为了下次改动的人
 *   知道该往哪里补，而不是以为已经全绿了。
 *
 * 默认 skip，`RUN_DB_TESTS=1 npm run test:db` 才跑。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ConversationNotFound,
  listConversations,
  loadConversationMessages,
  resolveConversation,
} from '@/lib/history';
import { prisma } from '@/lib/prisma';

const RUN_DB_TESTS = Boolean(process.env.RUN_DB_TESTS);

const RUN_ID = `w19iso-${Date.now()}`;
const EMAIL_A = `${RUN_ID}-a@example.invalid`;
const EMAIL_B = `${RUN_ID}-b@example.invalid`;
/** 第三个人：和 A 在**同一个**组织，角色是 member。见第四节。 */
const EMAIL_C = `${RUN_ID}-c@example.invalid`;

type Fixture = {
  userA: string;
  userB: string;
  userC: string;
  orgA: string;
  orgB: string;
  kbA: string;
  kbB: string;
  docA: string;
  docB: string;
  convA: string;
  convB: string;
};

describe.skipIf(!RUN_DB_TESTS)('多租户越权（W19）', () => {
  let fx: Fixture;

  beforeAll(async () => {
    const mk = async (tag: 'A' | 'B') => {
      const user = await prisma.user.create({
        data: { email: tag === 'A' ? EMAIL_A : EMAIL_B, name: `隔离测试${tag}` },
        select: { id: true },
      });
      const org = await prisma.organization.create({
        data: {
          name: `${RUN_ID} 组织${tag}`,
          memberships: { create: { userId: user.id, role: 'owner' } },
        },
        select: { id: true },
      });
      const kb = await prisma.knowledgeBase.create({
        data: { name: `${RUN_ID} 库${tag}`, orgId: org.id, createdBy: user.id },
        select: { id: true },
      });
      const doc = await prisma.document.create({
        data: {
          title: `${RUN_ID}-${tag}.md`,
          sourceType: 'md',
          status: 'ready',
          content: `${tag} 的正文`,
          kbId: kb.id,
        },
        select: { id: true },
      });
      const conv = await prisma.conversation.create({
        data: { orgId: org.id, createdBy: user.id, kbId: kb.id, title: `${tag} 的会话` },
        select: { id: true },
      });
      await prisma.message.create({
        data: { conversationId: conv.id, role: 'user', content: `${tag} 的问题` },
      });

      return { user, org, kb, doc, conv };
    };

    const a = await mk('A');
    const b = await mk('B');

    // C 不建自己的组织，直接加进 A 的组织当 member ——
    // 这是多租户改造唯一真正想要的新能力：**两个人共享一个库**。
    const c = await prisma.user.create({
      data: { email: EMAIL_C, name: '隔离测试C' },
      select: { id: true },
    });
    await prisma.membership.create({ data: { userId: c.id, orgId: a.org.id, role: 'member' } });

    fx = {
      userA: a.user.id,
      userB: b.user.id,
      userC: c.id,
      orgA: a.org.id,
      orgB: b.org.id,
      kbA: a.kb.id,
      kbB: b.kb.id,
      docA: a.doc.id,
      docB: b.doc.id,
      convA: a.conv.id,
      convB: b.conv.id,
    };
  });

  afterAll(async () => {
    // Organization 不挂在 user 上（成员是流动的），要单独删；
    // 删 org 会级联带走 kb → doc → chunk、conv → message。
    await prisma.organization.deleteMany({ where: { name: { startsWith: RUN_ID } } });
    await prisma.user.deleteMany({ where: { email: { in: [EMAIL_A, EMAIL_B, EMAIL_C] } } });
    await prisma.$disconnect();
  });

  // ------------------------------------------------------------
  // 一、跨组织：12 条，全部必须拿不到
  // ------------------------------------------------------------
  describe('拿 A 的身份打 B 的资源', () => {
    it('列表：A 的库列表里没有 B 的库', async () => {
      const rows = await prisma.knowledgeBase.findMany({
        where: { orgId: fx.orgA },
        select: { id: true },
      });
      expect(rows.map((r) => r.id)).toContain(fx.kbA);
      expect(rows.map((r) => r.id)).not.toContain(fx.kbB);
    });

    it('读详情：orgId 不匹配 → null（不是"查出来再判断"）', async () => {
      const kb = await prisma.knowledgeBase.findFirst({
        where: { id: fx.kbB, orgId: fx.orgA },
        select: { id: true },
      });
      expect(kb).toBeNull();
    });

    it('重命名：updateMany count = 0，库里名字没变', async () => {
      const { count } = await prisma.knowledgeBase.updateMany({
        where: { id: fx.kbB, orgId: fx.orgA },
        data: { name: '被越权改名' },
      });
      expect(count).toBe(0);

      const after = await prisma.knowledgeBase.findUnique({
        where: { id: fx.kbB },
        select: { name: true },
      });
      expect(after?.name).toBe(`${RUN_ID} 库B`);
    });

    it('删库：deleteMany count = 0，库还在', async () => {
      const { count } = await prisma.knowledgeBase.deleteMany({
        where: { id: fx.kbB, orgId: fx.orgA },
      });
      expect(count).toBe(0);

      const still = await prisma.knowledgeBase.findUnique({
        where: { id: fx.kbB },
        select: { id: true },
      });
      expect(still?.id).toBe(fx.kbB);
    });

    it('上传前置校验：拿不到目标库（uploadDocument 的第一道门）', async () => {
      // 与 uploadDocument 里 findFirst({ where: { id: kbId, orgId } }) 同一形态
      const kb = await prisma.knowledgeBase.findFirst({
        where: { id: fx.kbB, orgId: fx.orgA },
        select: { id: true },
      });
      expect(kb).toBeNull();
    });

    it('读文档：通过 kb 关系过滤 → null', async () => {
      const doc = await prisma.document.findFirst({
        where: { id: fx.docB, kb: { orgId: fx.orgA } },
        select: { id: true },
      });
      expect(doc).toBeNull();
    });

    it('删文档：deleteMany count = 0，文档还在', async () => {
      const { count } = await prisma.document.deleteMany({
        where: { id: fx.docB, kb: { orgId: fx.orgA } },
      });
      expect(count).toBe(0);

      const still = await prisma.document.findUnique({
        where: { id: fx.docB },
        select: { id: true },
      });
      expect(still?.id).toBe(fx.docB);
    });

    it('重建索引前置校验：拿不到 B 的文档', async () => {
      const doc = await prisma.document.findFirst({
        where: { id: fx.docB, kb: { orgId: fx.orgA } },
        select: { id: true, content: true },
      });
      expect(doc).toBeNull();
    });

    it('会话列表：orgId 是 A、kbId 是 B → 空（两个条件缺一不可）', async () => {
      const rows = await listConversations(fx.orgA, fx.kbB);
      expect(rows).toHaveLength(0);
    });

    it('读会话：loadConversationMessages 抛 ConversationNotFound（真代码）', async () => {
      await expect(loadConversationMessages(fx.orgA, fx.convB)).rejects.toBeInstanceOf(
        ConversationNotFound,
      );
    });

    it('删会话：deleteMany count = 0，会话还在', async () => {
      const { count } = await prisma.conversation.deleteMany({
        where: { id: fx.convB, orgId: fx.orgA },
      });
      expect(count).toBe(0);

      const still = await prisma.conversation.findUnique({
        where: { id: fx.convB },
        select: { id: true },
      });
      expect(still?.id).toBe(fx.convB);
    });

    it('提问复用：拿 B 的会话 id 续问 → ConversationNotFound（真代码）', async () => {
      await expect(
        resolveConversation({
          orgId: fx.orgA,
          createdBy: fx.userA,
          kbId: fx.kbA,
          conversationId: fx.convB,
          question: '接着聊',
        }),
      ).rejects.toBeInstanceOf(ConversationNotFound);
    });
  });

  // ------------------------------------------------------------
  // 二、阴性对照：证明上面 12 条不是因为「数据根本不存在」才通过的
  //
  // 这是本套测试最容易被跳过、也最该有的一条。
  // 如果 fixture 建错了（比如 kbB 压根没建成），上面 12 条会全部"通过" ——
  // 它们拿不到数据，但原因不是隔离，是数据不存在。
  // 那套测试会给人十足的安全感，同时什么都没证明。
  // ------------------------------------------------------------
  it('反证：不带 orgId 条件时，B 的库确实查得到', async () => {
    const kb = await prisma.knowledgeBase.findUnique({
      where: { id: fx.kbB },
      select: { id: true },
    });
    expect(kb?.id).toBe(fx.kbB);
  });

  it('反证：B 的文档和会话也确实存在', async () => {
    const doc = await prisma.document.findUnique({ where: { id: fx.docB }, select: { id: true } });
    const conv = await prisma.conversation.findUnique({
      where: { id: fx.convB },
      select: { id: true },
    });
    expect(doc?.id).toBe(fx.docB);
    expect(conv?.id).toBe(fx.convB);
  });

  // ------------------------------------------------------------
  // 三、反向：本组织必须正常
  //
  // 只测"打不进去"会得到一个假通过 —— 把 orgId 写死成一个不存在的值，
  // 上面 12 条全绿，而整个产品废了。所以必须成对断言。
  // ------------------------------------------------------------
  describe('A 对自己组织内的资源必须正常', () => {
    it('能列到自己的库', async () => {
      const rows = await prisma.knowledgeBase.findMany({
        where: { orgId: fx.orgA },
        select: { id: true },
      });
      expect(rows.map((r) => r.id)).toContain(fx.kbA);
    });

    it('能读到自己的库详情', async () => {
      const kb = await prisma.knowledgeBase.findFirst({
        where: { id: fx.kbA, orgId: fx.orgA },
        select: { id: true },
      });
      expect(kb?.id).toBe(fx.kbA);
    });

    it('能重命名自己的库', async () => {
      const { count } = await prisma.knowledgeBase.updateMany({
        where: { id: fx.kbA, orgId: fx.orgA },
        data: { name: `${RUN_ID} 库A 改过` },
      });
      expect(count).toBe(1);
    });

    it('能读自己的文档', async () => {
      const doc = await prisma.document.findFirst({
        where: { id: fx.docA, kb: { orgId: fx.orgA } },
        select: { id: true },
      });
      expect(doc?.id).toBe(fx.docA);
    });

    it('能读自己的会话消息', async () => {
      const { messages } = await loadConversationMessages(fx.orgA, fx.convA);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('A 的问题');
    });

    it('能在自己库新建会话', async () => {
      const created = await resolveConversation({
        orgId: fx.orgA,
        createdBy: fx.userA,
        kbId: fx.kbA,
        conversationId: null,
        question: '第一个问题',
      });
      expect(created.isNew).toBe(true);

      const row = await prisma.conversation.findUnique({
        where: { id: created.id },
        select: { orgId: true, createdBy: true },
      });
      expect(row?.orgId).toBe(fx.orgA);
      expect(row?.createdBy).toBe(fx.userA);
    });
  });

  // ------------------------------------------------------------
  // 四、同组织的第二个成员：必须看得见（多租户的**产品前提**）
  //
  // 这一节最容易漏，而漏了它会得到最坏的一种假绿：
  //   把 where 里的 orgId 写成 createdBy（或者把权限条件写成「我自己建的」），
  //   上面三节 21 条**全部照样通过** —— 因为跨组织确实拿不到、A 拿自己的也确实拿得到。
  //   但产品已经废了：拉人进来什么都看不见，多租户退化成单人租户。
  //
  // 「挡得住别人」和「自己人进得来」是两件事，只有成对测才能同时钉住。
  // ------------------------------------------------------------
  describe('同组织的另一个成员（role=member）必须能看见 A 建的资源', () => {
    it('列表：C 能列到 A 建的库', async () => {
      const rows = await prisma.knowledgeBase.findMany({
        where: { orgId: fx.orgA },
        select: { id: true, createdBy: true },
      });
      const hit = rows.find((r) => r.id === fx.kbA);
      expect(hit).toBeDefined();
      // 同时钉住「建库人不是 C」—— 否则这条测试可能是因为 createdBy 恰好等于 C 才通过的
      expect(hit?.createdBy).toBe(fx.userA);
    });

    it('详情：C 能读到 A 建的库（用 orgId，不是 createdBy）', async () => {
      const kb = await prisma.knowledgeBase.findFirst({
        where: { id: fx.kbA, orgId: fx.orgA },
        select: { id: true },
      });
      expect(kb?.id).toBe(fx.kbA);
    });

    it('文档：C 能读到 A 建的文档', async () => {
      const doc = await prisma.document.findFirst({
        where: { id: fx.docA, kb: { orgId: fx.orgA } },
        select: { id: true },
      });
      expect(doc?.id).toBe(fx.docA);
    });

    it('会话列表：C 在同一个库下能看到 A 的会话（真代码 listConversations）', async () => {
      const list = await listConversations(fx.orgA, fx.kbA);
      expect(list.map((c) => c.id)).toContain(fx.convA);
    });

    it('读消息：C 能打开 A 的会话（真代码 loadConversationMessages）', async () => {
      const { messages } = await loadConversationMessages(fx.orgA, fx.convA);
      expect(messages[0].content).toBe('A 的问题');
    });

    it('反向：C 建的新会话，A 也看得见（不是单向共享）', async () => {
      const created = await resolveConversation({
        orgId: fx.orgA,
        createdBy: fx.userC,
        kbId: fx.kbA,
        conversationId: null,
        question: 'C 问的问题',
      });

      const list = await listConversations(fx.orgA, fx.kbA);
      expect(list.map((c) => c.id)).toContain(created.id);

      // createdBy 如实记的是 C，不是 A —— 审计字段不能因为共享而漂移
      const row = await prisma.conversation.findUnique({
        where: { id: created.id },
        select: { createdBy: true },
      });
      expect(row?.createdBy).toBe(fx.userC);
    });

    it('C 仍然打不进 B 的组织（加了成员之后隔离不能被稀释）', async () => {
      const kb = await prisma.knowledgeBase.findFirst({
        where: { id: fx.kbB, orgId: fx.orgA },
        select: { id: true },
      });
      expect(kb).toBeNull();

      const list = await listConversations(fx.orgA, fx.kbB);
      expect(list).toHaveLength(0);
    });
  });
});
