/**
 * 问答接口：POST /api/kb/[id]/chat
 * body: { question: string, conversationId?: string }
 *
 * 响应是一个自定义的简单流协议（不引入 SSE 库，前端 fetch + reader 就能读）：
 *   第一行： {"citations":[...],"conversationId":"..."}   ← 引用快照 + 本次会话 id
 *   之后：   纯文本增量，直接拼到答案区
 *   错误：   正文里出现 \u0000 开头的行 = 生成失败，后面跟人话错误信息
 *          （HTTP 状态码已经发不出去了 —— 流式响应头早就 200 了，
 *           所以中途错误只能走内协议。这是流式接口的经典约束。）
 *
 * 鉴权与归属（spec D2）：requireUserId + findFirst({ id, userId }) 双保险，
 * 和页面同一个套路 —— UI 看不到入口不算安全，接口层必须自己校验。
 *
 * W5 引入持久化后，这个接口多了一条**落库时序**要遵守（spec A2）：
 *   ① 立刻写 user 消息 → ② 检索 → ③ 流式生成 → ④ 流结束才写 assistant
 * 顺序反了就会在崩溃时丢掉用户的提问（curl 打接口中途 Ctrl+C 那条判据验的就是它）。
 */
import {
  encodeErrorLine,
  encodeHeadLine,
  type Citation,
} from '@/lib/chat-protocol';
import {
  appendAssistantMessage,
  appendUserMessage,
  ConversationNotFound,
  loadContext,
  resolveConversation,
} from '@/lib/history';
import { buildRagMessages, streamChat } from '@/lib/llm';
import { prisma } from '@/lib/prisma';
import { retrieve } from '@/lib/retrieve';
import { requireUserId } from '@/lib/session';

const MAX_QUESTION_LENGTH = 1000;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: kbId } = await params;
  const userId = await requireUserId();

  // 归属校验：kbId 来自 URL，必须验过才准往下走（D1/D2 的第一道门）
  const kb = await prisma.knowledgeBase.findFirst({
    where: { id: kbId, userId },
    select: { id: true },
  });
  if (!kb) {
    // 用 404 而不是 403：不向 probing 的请求泄露"这个库存在，只是不是你的"
    return Response.json({ error: '知识库不存在' }, { status: 404 });
  }

  let question: string;
  let conversationId: string | null;
  try {
    const body = (await request.json()) as {
      question?: unknown;
      conversationId?: unknown;
    };
    question = typeof body.question === 'string' ? body.question.trim() : '';
    conversationId =
      typeof body.conversationId === 'string' && body.conversationId
        ? body.conversationId
        : null;
  } catch {
    return Response.json({ error: '请求格式错误' }, { status: 400 });
  }
  if (!question) {
    return Response.json({ error: '问题不能为空' }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return Response.json(
      { error: `问题不能超过 ${MAX_QUESTION_LENGTH} 字` },
      { status: 400 },
    );
  }

  // 会话：复用或新建。这一步同时做了 userId / kbId 双重归属校验（spec C1 / C2）
  let conversation: { id: string };
  try {
    conversation = await resolveConversation({ userId, kbId, conversationId, question });
  } catch (error) {
    if (error instanceof ConversationNotFound) {
      return Response.json({ error: '会话不存在' }, { status: 404 });
    }
    throw error;
  }

  // ① user 消息立刻落库：之后无论怎么崩，用户回来都看得到自己问过什么
  await appendUserMessage(conversation.id, question);
  const { messages: history, turn } = await loadContext(conversation.id);

  let chunks;
  try {
    chunks = await retrieve(kbId, question);
  } catch (error) {
    return Response.json(
      { error: `检索失败：${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }

  const shortConv = conversation.id.slice(0, 8);
  console.log(`[chat] 第 ${turn} 轮 kb=${kbId.slice(0, 8)} conv=${shortConv} 历史 ${history.length} 条`);

  /**
   * citations 在**流之外**先算好：它不是"生成到哪才有的东西"，
   * 而是这次检索的结果快照 —— 哪怕用户中途按停，它也是完整的。
   * content 带全文，所以必须是一致的同一份（spec B2 / A3）。
   */
  const citations: Citation[] = chunks.map((c) => ({
    chunkIndex: c.chunkIndex,
    documentId: c.documentId,
    documentTitle: c.documentTitle,
    similarity: c.similarity,
    content: c.content,
  }));

  const t0 = Date.now();
  const encoder = new TextEncoder();
  let answer = '';
  let persisted = false;

  /**
   * 落 assistant 消息。
   *
   * complete = 正常生成完；stopped = 用户按了停止生成（spec D4）。
   * 失败时不调用它 —— 历史里留下一条没有回答的 user 消息，由 UI 推断"未完成"（spec D1 / D5）。
   */
  async function persistAssistant(finishReason: 'complete' | 'stopped') {
    if (persisted) return;
    persisted = true;
    // 一个字都没吐出来就别留空气泡；空字符串只会污染历史
    if (!answer.trim()) return;
    try {
      await appendAssistantMessage({
        conversationId: conversation.id,
        content: answer,
        citations,
        finishReason,
      });
      // 会话列表按 updatedAt 排序，写消息不会自动顶上去 —— 手动 touch 一次。
      // 不 touch 的话，"最近会话"其实是"最近创建的会话"，聊过的老会话永远沉底。
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() },
      });
    } catch (error) {
      // 保存失败不能影响已经发给用户的答案，但必须看得见
      console.error(
        `[chat] conv=${shortConv} 保存助手消息失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // 第一行：引用快照 + 会话 id（A5：新会话的 id 必须搭这一行回到前端）
      controller.enqueue(encoder.encode(encodeHeadLine({ citations, conversationId: conversation.id })));

      try {
        let firstTokenAt = 0;
        /**
         * 把 request.signal 透传给上游 fetch：用户按停止／关页面时，
         * 前端 abort → 这个 Request 的 body 被 cancel → signal 触发 → 上游请求也停，
         * 不再为没人看的答案付 token。（这也是 readStream 能被感知的原因。）
         */
        for await (const delta of streamChat(buildRagMessages(question, chunks, history), {
          signal: request.signal,
        })) {
          if (!firstTokenAt) {
            firstTokenAt = Date.now() - t0;
            console.log(`[chat] conv=${shortConv} 首字 ${firstTokenAt}ms（含检索）`);
          }
          answer += delta;
          controller.enqueue(encoder.encode(delta));
        }
        console.log(`[chat] conv=${shortConv} 总耗时 ${Date.now() - t0}ms`);
        await persistAssistant('complete');
      } catch (error) {
        const isAbort = error instanceof Error && error.name === 'AbortError';
        if (isAbort) {
          // 用户主动停止：已生成的内容要留下（spec D4），不算错误
          await persistAssistant('stopped');
        } else {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[chat] conv=${shortConv} 生成失败：${message}`);
          // 流式响应头已发出，状态码改不了 —— 只能走内协议把错误带给前端
          try {
            controller.enqueue(encoder.encode(encodeErrorLine(message)));
          } catch {
            // controller 可能已被客户端断开关闭，忽略
          }
        }
      } finally {
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      }
    },

    /**
     * 客户端断开连接。可能是用户点了「停止生成」，也可能是关了标签页 ——
     * 两种我们都不该当作错误，而是把已经生成的部分落库。
     *
     * ⚠️ 这是 MVP 实现：在 Serverless 上函数可能在 await 完成前就被冻结，
     * 停止那一刻的内容有极小概率丢。W6 再考虑改用 after() 之类的后置钩子。
     */
    cancel() {
      void persistAssistant('stopped');
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      // 防止中间层缓冲整个响应再下发（nginx 默认会缓冲，Vercel 不需要但无害）
      'X-Accel-Buffering': 'no',
    },
  });
}
