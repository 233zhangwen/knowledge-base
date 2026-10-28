/**
 * Agent 版问答接口：POST /api/kb/[id]/chat-agent（W10）
 *
 * 与旧端点 /chat 的关系（spec 方案 D-0 = B，并存）：
 *   - 旧端点原样保留，W6 评测基线依赖它，W11 agent 验收后再删；
 *   - 本端点把"必检索"换成"模型决定何时检索"（retrieve 成了工具），
 *     多跳问题有了协议通道。
 *
 * 流协议 v2（定义在 chat-protocol.ts，前后端共用一份）：
 *   第一行： {"v":2,"conversationId":"..."}\n
 *   事件行： {"tool":{"question":"..."}} / {"citations":[...]}（均在文本前）
 *   之后：   纯文本增量（与 v1 相同）
 *   错误：   \u0000 哨兵行（与 v1 相同）
 *
 * 落库时序与 v1 完全一致（spec B4）：① user 先落 → ② Agent 循环 →
 * ③ 流结束落 assistant（citations = 全部工具结果的合并快照）。
 * 顺序反了就会在崩溃时丢掉用户的提问 —— 这条时序是 W5 spec A2 定下的，不许动。
 */
import {
  encodeCitationsLine,
  encodeErrorLine,
  encodeHeadLineV2,
  encodeToolLine,
  type Citation,
} from '@/lib/chat-protocol';
import {
  appendAssistantMessage,
  appendUserMessage,
  ConversationNotFound,
  loadContext,
  resolveConversation,
} from '@/lib/history';
import { runAgentTurn } from '@/lib/agent-llm';
import { prisma } from '@/lib/prisma';
import { requireUserId } from '@/lib/session';

const MAX_QUESTION_LENGTH = 1000;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: kbId } = await params;
  const userId = await requireUserId();

  // 归属校验：与旧端点同套路（D1/D2 第一道门）
  const kb = await prisma.knowledgeBase.findFirst({
    where: { id: kbId, userId },
    select: { id: true },
  });
  if (!kb) {
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

  let conversation: { id: string };
  try {
    conversation = await resolveConversation({ userId, kbId, conversationId, question });
  } catch (error) {
    if (error instanceof ConversationNotFound) {
      return Response.json({ error: '会话不存在' }, { status: 404 });
    }
    throw error;
  }

  // ① user 消息立刻落库（时序不许动，见文件头）
  await appendUserMessage(conversation.id, question);
  const { messages: history, turn } = await loadContext(conversation.id);

  const shortConv = conversation.id.slice(0, 8);
  console.log(`[agent] 第 ${turn} 轮 kb=${kbId.slice(0, 8)} conv=${shortConv} 历史 ${history.length} 条`);

  let answer = '';
  let persisted = false;

  async function persistAssistant(finishReason: 'complete' | 'stopped', citations: Citation[]) {
    if (persisted) return;
    persisted = true;
    if (!answer.trim()) return;
    try {
      await appendAssistantMessage({
        conversationId: conversation.id,
        content: answer,
        citations,
        finishReason,
      });
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() },
      });
    } catch (error) {
      console.error(
        `[agent] conv=${shortConv} 保存助手消息失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const encoder = new TextEncoder();
  const t0 = Date.now();
  /** 最终落库快照：与模型看到的编号账本严格同序（事件里 push，cancel 也能拿到） */
  const citations: Citation[] = [];

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // 第一行：只有会话 id（v2：citations 是流中产物，改走事件行）
      controller.enqueue(encoder.encode(encodeHeadLineV2(conversation.id)));

      try {
        // loadContext 的 ChatMessage.role 理论上含 'system'（实际历史不会出现），
        // Agent 层收的是窄化的 user/assistant —— 在边界上收敛一次，不放宽 Agent 层。
        const agentHistory = history.map((m) => ({
          role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
          content: m.content,
        }));
        for await (const event of runAgentTurn({
          kbId,
          question,
          history: agentHistory,
          signal: request.signal,
        })) {
          switch (event.type) {
            case 'tool':
              // E2：检索状态行（前端可用来显示"正在检索：xxx"）
              console.log(`[agent] conv=${shortConv} 检索：${event.question}`);
              controller.enqueue(encoder.encode(encodeToolLine(event.question)));
              break;
            case 'citations':
              citations.push(...event.citations);
              controller.enqueue(encoder.encode(encodeCitationsLine(event.citations)));
              break;
            case 'delta':
              answer += event.text;
              controller.enqueue(encoder.encode(event.text));
              break;
            case 'finish':
              console.log(
                `[agent] conv=${shortConv} 完成：steps=${event.steps} ` +
                  `tokens=${event.usage.inputTokens}/${event.usage.outputTokens} ` +
                  `citations=${citations.length} 总耗时 ${Date.now() - t0}ms`,
              );
              break;
          }
        }
        await persistAssistant('complete', citations);
      } catch (error) {
        const isAbort = error instanceof Error && error.name === 'AbortError';
        if (isAbort) {
          await persistAssistant('stopped', citations);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[agent] conv=${shortConv} 生成失败：${message}`);
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

    cancel() {
      void persistAssistant('stopped', citations);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
