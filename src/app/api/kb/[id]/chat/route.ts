/**
 * 问答接口：POST /api/kb/[id]/chat
 * body: { question: string }
 *
 * 响应是一个自定义的简单流协议（不引入 SSE 库，前端 fetch + reader 就能读）：
 *   第一行：citations 的 JSON（检索结果，含片段全文，供引用组件展示）
 *   之后： 纯文本增量，直接拼到答案区
 *   错误： 正文里出现 \u0000 开头的行 = 生成失败，后面跟人话错误信息
 *          （HTTP 状态码已经发不出去了 —— 流式响应头早就 200 了，
 *           所以中途错误只能带内协议。这是流式接口的经典约束。）
 *
 * 鉴权与归属（spec D2）：requireUserId + findFirst({ id, userId }) 双保险，
 * 和页面同一个套路 —— UI 看不到入口不算安全，接口层必须自己校验。
 */
import {
  encodeCitationsLine,
  encodeErrorLine,
  type Citation,
} from '@/lib/chat-protocol';
import { buildRagMessages, streamChat } from '@/lib/llm';
import { prisma } from '@/lib/prisma';
import { requireUserId } from '@/lib/session';
import { retrieve } from '@/lib/retrieve';

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
  try {
    const body = (await request.json()) as { question?: unknown };
    question = typeof body.question === 'string' ? body.question.trim() : '';
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

  let chunks;
  try {
    chunks = await retrieve(kbId, question);
  } catch (error) {
    return Response.json(
      { error: `检索失败：${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }

  const encoder = new TextEncoder();
  const t0 = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // 第一行：citations（引用组件的数据源；带全文，C2 要点开展示）
      // 编号 [1]..[N] 的顺序就是 chunks 的顺序，llm.ts 里拼 Prompt 用的是同一个数组，
      // 所以"模型看到的 [i]" === "前端展示的第 i 条"（spec C1）。
      const citations: Citation[] = chunks.map((c) => ({
        chunkIndex: c.chunkIndex,
        documentId: c.documentId,
        documentTitle: c.documentTitle,
        similarity: c.similarity,
        content: c.content,
      }));
      controller.enqueue(encoder.encode(encodeCitationsLine(citations)));

      try {
        let firstTokenAt = 0;
        for await (const delta of streamChat(buildRagMessages(question, chunks))) {
          if (!firstTokenAt) {
            firstTokenAt = Date.now() - t0;
            console.log(`[chat] kb=${kbId.slice(0, 8)} 首字 ${firstTokenAt}ms（含检索）`);
          }
          controller.enqueue(encoder.encode(delta));
        }
        console.log(`[chat] kb=${kbId.slice(0, 8)} 总耗时 ${Date.now() - t0}ms`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[chat] 生成失败：${message}`);
        // 流式响应头已发出，状态码改不了 —— 只能走内协议把错误带给前端
        controller.enqueue(encoder.encode(encodeErrorLine(message)));
      } finally {
        controller.close();
      }
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
