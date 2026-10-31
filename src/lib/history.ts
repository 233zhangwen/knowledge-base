/**
 * 会话历史层：会话的定位（复用 / 新建 / 归属校验）+ 上下文窗口的拼装。
 *
 * 三个决策的落点都在这个文件里（详见 docs/ACCEPTANCE-W5.md 第一节）：
 *   ① citations 存快照 —— 体现在 appendAssistantMessage 的签名上，它收的是 Citation[] 全文，
 *      不是 chunkId。调用方（route.ts）传的是本次真正喂进 Prompt 的那份。
 *   ② 上下文只带最近 3 轮，且不带历史消息自己的 citations
 *      —— 见 loadContext 的 select：只拿 role / content，不拿 citations。
 *   ③ 会话分组代替分页 —— 列表查询在 page.tsx 里（take 20），这里只管单个会话。
 */
import type { Citation } from './chat-protocol';
import type { Prisma } from '@/generated/prisma/client';
import type { ChatMessage } from './llm';
import { log } from './log';
import { prisma } from './prisma';

/**
 * 上下文窗口：最近 3 轮 = 6 条消息。
 *
 * 为什么是 3：一轮问答不到 1000 token，3 轮约 3000；加 system + 5 个 chunk 约 1800，
 * 合计 5k 上下。DeepSeek 窗口远没到上限，**瓶颈不是窗口而是注意力稀释** ——
 * 塞 20 条进去，真正有用的那条反而被淹没（和 W4 选 TOP_K=5 是同一个判断）。
 * 这是个可调常量，不是架构决定：追问经常被截断就把它改成 5。
 */
export const HISTORY_TURNS = 3;
const HISTORY_MESSAGE_LIMIT = HISTORY_TURNS * 2;

/** 会话标题取首问前 20 个字。超长时截断加省略号。
 *  ⚠️ 实现搬到 ./conversation-title.ts（纯函数，不能和"顶层就连库"的模块混住，见那里的注释）。 */
export { titleFromQuestion } from './conversation-title';

/** 会话不存在或不属于当前用户/知识库。调用方应把它翻译成 404，而不是 403。 */
export class ConversationNotFound extends Error {
  constructor() {
    super('会话不存在');
    this.name = 'ConversationNotFound';
  }
}

/**
 * 复用已有会话，或新建会话。
 *
 * 两条校验一条都不能省（spec C1 / C2）：
 *   userId —— 改一下 URL 就能看别人全部对话记录，这是本项目最严重的一类缺陷；
 *   kbId   —— 会话是挂在某个知识库下的，借 A 库的会话去问 B 库，
 *             历史串了、检索却发生在当前库，表现出来只是"答案有点怪"。
 *
 * 返回 404 而不是 403：不向 probing 的请求泄露"这个会话存在，只是不是你的"。
 */
export async function resolveConversation(params: {
  userId: string;
  kbId: string;
  conversationId: string | null;
  question: string;
}): Promise<{ id: string; isNew: boolean }> {
  const { userId, kbId, conversationId, question } = params;

  if (conversationId) {
    const existing = await prisma.conversation.findFirst({
      where: { id: conversationId, userId, kbId },
      select: { id: true },
    });
    if (!existing) throw new ConversationNotFound();
    // debug 级：这是每次提问都会打的高频流水，排查"会话串了/没续上"时才打开
    log.debug('conversation.reuse', { convId: existing.id.slice(0, 8) });
    return { id: existing.id, isNew: false };
  }

  /**
   * 「未提问就不创建会话」（spec D2）：创建发生在这里 —— 也就是**第一次提问时**，
   * 而不是进入页面时。否则侧栏很快被几十个空会话刷屏。
   *
   * 副作用：这个新 id 必须回到前端（否则刷新后用户找不到这次会话，见 spec A5），
   * 走的是 chat 流的第一行 —— 见 chat-protocol.ts 的 encodeHeadLine。
   */
  const created = await prisma.conversation.create({
    data: { userId, kbId, title: titleFromQuestion(question) },
    select: { id: true },
  });
  log.debug('conversation.create', { convId: created.id.slice(0, 8) });
  return { id: created.id, isNew: true };
}

/**
 * 立刻落库 user 消息（spec A2）。
 *
 * 必须在生成**之前**写：万一后面崩了，用户回来至少知道自己刚才问了什么。
 * 这是 A2 那条可靠性判据（curl 打接口中途 Ctrl+C，库里必须有 user=1）的实现依据。
 */
export async function appendUserMessage(conversationId: string, content: string) {
  return prisma.message.create({
    data: { conversationId, role: 'user', content },
    select: { id: true },
  });
}

export type LoadedContext = {
  /** 拼进 llm.ts 的历史消息（不含当前这轮的问题） */
  messages: ChatMessage[];
  /** 当前是第几轮（1 起），只用于日志观测 spec D3 */
  turn: number;
};

/**
 * 取出用于拼上下文的历史消息。
 *
 * 两个必须处理的细节：
 *
 * 1. **倒序取、再反转**。`take` 只能从结果集的开头取，所以要
 *    `orderBy desc, take LIMIT` 拿到"最近的 N 条"，再 reverse 成正序。
 *    写成 `orderBy asc, take LIMIT` 会拿到**最老的** N 条 —— 上下文永远是第一轮，
 *    而且不报错，只是多轮完全失效。
 *
 * 2. **保证第一条是 user**。D1/D5 允许库里存在"没有回答的孤儿 user 消息"，
 *    它会让历史变成奇数条，截取之后就可能以一条 assistant 开头（它的问题被截掉了），
 *    甚至出现连续两条 user。部分 OpenAI 兼容 API 遇到这种序列会直接报错。
 *    宁可少带一轮，也不要畸形上下文。
 */
export async function loadContext(conversationId: string): Promise<LoadedContext> {
  const rows = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_MESSAGE_LIMIT,
    // 刻意不 select citations：历史消息自己的引用绝不带进上下文（决策②）
    select: { role: true, content: true },
  });

  const ordered = rows.reverse();
  while (ordered.length > 0 && ordered[0].role !== 'user') ordered.shift();

  const messages: ChatMessage[] = ordered.map((r) => ({
    role: r.role === 'assistant' ? 'assistant' : 'user',
    content: r.content,
  }));

  const turn = await prisma.message.count({
    where: { conversationId, role: 'user' },
  });

  return { messages, turn };
}

/**
 * 落 assistant 消息。
 *
 * citations 参数的类型就是 Citation 快照数组（含片段全文）—— 不存 chunkId，见文件头 ①。
 *
 * finishReason：
 *   'stopped' = 用户按了停止生成，内容是半截的（spec D4）
 *   'complete' = 正常结束
 * 生成失败时**不调用这个函数**（spec D1）—— 历史里留下一条没有回答的 user 消息，
 * 由 UI 侧推断出"未完成"（spec D5）。宁可留孤儿，也不留一条写着"生成失败"的假回答。
 */
export async function appendAssistantMessage(params: {
  conversationId: string;
  content: string;
  /** Citation 快照数组（含片段全文）。用 InputJsonValue 收，避免调用方到处 as any */
  citations: Citation[];
  finishReason: 'complete' | 'stopped';
  /**
   * 每答成本（W13 D 组）。全部可选：
   *   stopped（用户中断）时上游没发 finish，拿不到 usage —— 这不是缺陷，是事实，
   *   宁可留空也不要填 0（0 会把统计均值拉低，比缺数据更糟）。
   */
  cost?: { inputTokens?: number; outputTokens?: number; steps?: number; latencyMs?: number };
}) {
  return prisma.message.create({
    data: {
      conversationId: params.conversationId,
      role: 'assistant',
      content: params.content,
      citations: params.citations as unknown as Prisma.InputJsonValue,
      finishReason: params.finishReason,
      inputTokens: params.cost?.inputTokens ?? null,
      outputTokens: params.cost?.outputTokens ?? null,
      steps: params.cost?.steps ?? null,
      latencyMs: params.cost?.latencyMs ?? null,
    },
    select: { id: true },
  });
}

/**
 * 会话列表（决策③：最近 N 个，不做分页）。
 * 会话本身就是天然的数据边界 —— 一次会话很少超过 30 条消息，
 * 用它做分组就已经解决了"数据量无限增长"，不需要再套一层分页。
 */
export async function listConversations(userId: string, kbId: string, take = 20) {
  return prisma.conversation.findMany({
    where: { userId, kbId },
    orderBy: { updatedAt: 'desc' },
    take,
    select: {
      id: true,
      title: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });
}

/**
 * 单个会话的全部消息（按时间正序）。
 *
 * ⚠️ title 可能为空：用户首创提问后、流还没结束就刷新，标题此时还没写吗？
 * 不 —— 标题在建会话时就写了（取的就是第一句话），所以只有极端异常才会为空。
 * UI 侧仍要兜住 null，别直接渲染。
 */
export async function loadConversationMessages(userId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    select: { id: true, kbId: true, title: true },
  });
  if (!conversation) throw new ConversationNotFound();

  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      role: true,
      content: true,
      citations: true,
      finishReason: true,
    },
  });

  return { conversation, messages };
}
