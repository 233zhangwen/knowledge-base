'use client';

/**
 * 问答面板（W5 版：会话化）。
 *
 * 这一层是整个项目唯一「前端自己读流」的地方。服务端 llm.ts 读一遍上游的 SSE，
 * 这里再读一遍下游的字节流，两段代码是同一个模式：
 *   getReader() → while(read()) → 累积 → 交给协议解析器切出可用部分
 * 看懂一段，另一段就是同一套。
 *
 * 为什么不用 `<form action={serverAction}>`：
 *   ① 要读流式响应，必须自己 fetch；
 *   ② React 19 会在 action 完成后自动 reset 表单（见 RenameForm 注释），
 *      而这里失败时恰恰要保留用户刚打的问题。受控 textarea 才守得住。
 *
 * ⚠️ 本组件由 page.tsx 用 key={conversationId} 强制重挂载来清空状态 ——
 * 不是偷懒：useActionState / useState 都没有 reset API，切换会话时
 * 最可靠的"重置一切"就是卸载重来（这个套路 RenameForm 里用过一次）。
 */
import { useEffect, useRef, useState } from 'react';

import {
  createCursor,
  feed,
  type Citation,
  type StreamCursor,
} from '@/lib/chat-protocol';

/** 与 route.ts 里的 MAX_QUESTION_LENGTH 一致：前端先拦，省一次往返。 */
const MAX_QUESTION_LENGTH = 1000;

/** 本地还没拿到服务端 id 时用的占位 id，刷新后由服务端数据接管。 */
const STREAMING_ID = '__streaming__';

export type UiMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[] | null;
  /** stopped = 用户按了停止生成，内容是半截的（spec D4） */
  finishReason: 'complete' | 'stopped';
};

export function ChatPanel({
  kbId,
  conversationId,
  initialMessages,
  disabled,
}: {
  kbId: string;
  conversationId: string | null;
  initialMessages: UiMessage[];
  disabled?: boolean;
}) {
  const [messages, setMessages] = useState<UiMessage[]>(initialMessages);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  /** 本次会话 id：首次提问前是 null，服务端随流第一行给回来（spec A5） */
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    conversationId,
  );
  const [abort, setAbort] = useState<(() => void) | null>(null);

  /**
   * 滚动跟随（2026-10-27 改版）：
   * 消息列表是内部滚动的固定高度区域，流式生成时必须自动滚到底，
   * 否则用户看到的是"卡住的头几句"而最新内容在看不见的地方长。
   *
   * stickToBottom：用户往上翻了就不许再拽 —— 强制跟随是反人类的。
   * 判据是"是否接近底部"（80px 容差），滚回底部附近后跟随自动恢复。
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    // messages 每次流式更新都是新数组，引用变化即可覆盖"内容变长"和"条数变多"
  }, [messages]);

  async function ask() {
    const q = question.trim();
    if (!q || isStreaming) return;

    setQuestion('');
    setError(null);
    setIsStreaming(true);

    // 乐观追加：用户立刻看到自己问了什么，不用等服务端回轮子
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: 'user', content: q, citations: null, finishReason: 'complete' },
      { id: STREAMING_ID, role: 'assistant', content: '', citations: [], finishReason: 'complete' },
    ]);

    const controller = new AbortController();
    setAbort(() => controller.abort.bind(controller));

    try {
      const res = await fetch(`/api/kb/${kbId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, conversationId: activeConversationId }),
        signal: controller.signal,
      });

      // 鉴权 / 归属 / 参数错误在这里就返回了，还没进流
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `请求失败（HTTP ${res.status}）`);
        dropStreamingSlot();
        setIsStreaming(false);
        setAbort(null);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const cursor: StreamCursor = createCursor();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        feed(cursor, decoder.decode(value, { stream: true }));
        if (cursor.conversationId && cursor.conversationId !== activeConversationId) {
          setActiveConversationId(cursor.conversationId);
        }
        updateStreamingSlot(cursor);
      }

      setIsStreaming(false);
      setAbort(null);

      if (cursor.errorMode) {
        // 错误信息可能到流末尾才收全，这里用最终值兜一次
        setError(cursor.error.trim() || '生成失败');
        // 失败时不留 assistant 气泡：真正的资料库里也没有这条（spec D1），
        // 界面如果自作主张留一个空回答，刷新后就"神秘消失"了。
        dropStreamingSlot();
      } else {
        finalizeStreamingSlot('complete');
      }
    } catch (e) {
      // 用户主动停止：保留已经生成的部分并标记为 stopped，不算错误（spec D4）
      if (e instanceof DOMException && e.name === 'AbortError') {
        finalizeStreamingSlot('stopped');
        setIsStreaming(false);
        setAbort(null);
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      dropStreamingSlot();
      setIsStreaming(false);
      setAbort(null);
    }
  }

  /** 把正在生成的那条 assistant 更新到最新内容 */
  function updateStreamingSlot(cursor: StreamCursor) {
    setMessages((prev) => {
      const rest = prev.at(-1)?.id === STREAMING_ID ? prev.slice(0, -1) : prev;
      return [
        ...rest,
        {
          id: STREAMING_ID,
          role: 'assistant',
          content: cursor.answer,
          citations: cursor.citations,
          finishReason: 'complete',
        },
      ];
    });
  }

  /**
   * 收尾：把占位 id 换成唯一 id，并把 finishReason 定下来。
   *
   * ⚠️ 换 id 这一步不能省：占位 id 是固定常量，不换的话下一轮新的占位
   * 会和上一轮那条同 id —— React key 撞车，而且 updateStreamingSlot 的
   * "最后一个是不是占位"判断会误判，把上一轮的答案当成流式的给覆盖掉。
   */
  function finalizeStreamingSlot(finishReason: 'complete' | 'stopped') {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === STREAMING_ID
          ? { ...m, id: `local-${Date.now()}`, finishReason }
          : m,
      ),
    );
  }

  /** 生成失败：撤掉占位的 assistant 气泡，留下那条没有答案的 user 消息（交给 D5 的提示去解释） */
  function dropStreamingSlot() {
    setMessages((prev) => prev.filter((m) => m.id !== STREAMING_ID));
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-3">
      <h2 className="text-sm font-medium text-zinc-500">提问</h2>

      {/* 历史消息必须在 disabled 分支之外渲染（2026-10-26 实测 bug）：
          disabled 的含义是"当前没有 ready 文档，不能提问"，它管的是输入区。
          之前整个消息列表被藏进这个分支，结果删掉文档后历史会话全部"打不开"——
          页面 200、侧栏正常，消息区却只剩一句占位符（spec A1/A3 直接被违反：
          刷新不丢变成了"有文档才不丢"）。看历史和发提问是两个独立能力。 */}
      {/*
        固定最大高度 + 内部滚动：对话长了之后页面不再被无限拉长，
        输入框永远在可视范围内（之前聊到 20 轮要滚过三屏才能打字）。
        pr-1 给滚动条留位，避免压住气泡右缘。
      */}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto pr-1"
      >
        {messages.map((m, i) => (
          <MessageView
            key={m.id}
            message={m}
            streaming={m.id === STREAMING_ID}
            /**
             * spec D5：一条 user 消息后面没有 assistant，说明当时生成失败或中断了。
             * 必须先把它说清楚 —— 否则用户隔天回来看到一句孤零零的提问，
             * 既不知道发生了什么，也不知道该不该重问。
             */
            orphan={
              m.role === 'user' &&
              !isStreaming &&
              (i === messages.length - 1 || messages[i + 1].role !== 'assistant')
            }
          />
        ))}
      </div>

      {disabled ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-zinc-400">
          还没有已就绪的文档。上传并索引完成后才能提问。
        </p>
      ) : (
        <>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={MAX_QUESTION_LENGTH}
            rows={3}
            placeholder="基于这个知识库的内容提问……（Enter 发送，Shift+Enter 换行）"
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey) return;
              // 桌面 Ctrl/Cmd+Enter 发送（Enter 留给换行）；
              // 触屏设备没有 Ctrl 键，Enter 直发。
              const isTouch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
              if (e.ctrlKey || e.metaKey || isTouch) {
                e.preventDefault();
                void ask();
              }
            }}
            className="w-full resize-y rounded-lg border p-3 text-sm outline-none focus:border-zinc-400"
          />

          <div className="flex items-center gap-3">
            {isStreaming ? (
              <button
                type="button"
                onClick={() => abort?.()}
                className="rounded-lg border px-4 py-2 text-sm hover:bg-zinc-50"
              >
                停止生成
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void ask()}
                disabled={!question.trim()}
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white disabled:bg-zinc-300"
              >
                提问
              </button>
            )}
            <span className="text-xs text-zinc-400">
              {question.length}/{MAX_QUESTION_LENGTH}
              {isStreaming ? ' · 正在检索并生成……' : ''}
            </span>
          </div>

          {error ? (
            <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              生成失败：{error}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function MessageView({
  message,
  streaming,
  orphan,
}: {
  message: UiMessage;
  streaming: boolean;
  orphan: boolean;
}) {
  const isUser = message.role === 'user';

  return (
    /**
     * 2026-10-27 改版：去掉"你/回答"文字标签，改左右分布 ——
     * 用户消息右对齐深色气泡、回答左对齐浅色，这是聊天界面的通用心智，
     * 不需要标签解释谁是谁。窄气泡（70%/88%）留白比全宽盒子舒服得多。
     */
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={isUser ? 'max-w-[75%]' : 'max-w-[88%]'}>
        <div
          className={
            isUser
              ? 'rounded-2xl rounded-br-sm bg-zinc-900 px-4 py-2.5 text-white'
              : 'rounded-2xl rounded-bl-sm bg-zinc-50 px-4 py-3'
          }
        >
          {/* pre-wrap：模型输出里的换行要原样呈现，否则段落糊成一团 */}
          <p className="whitespace-pre-wrap text-sm leading-7">
            {message.content}
            {/* 光标只在正在生成的那条末尾；历史消息一律不多一个字符 ——
                打字机重放属于 Out of Scope，历史就是静态文本 */}
            {streaming ? <span className="text-zinc-400">▌</span> : null}
          </p>
          {message.finishReason === 'stopped' ? (
            <p className={`mt-2 text-xs ${isUser ? 'text-zinc-400' : 'text-zinc-500'}`}>
              已停止生成（内容可能不完整）
            </p>
          ) : null}
        </div>

        {message.citations && message.citations.length > 0 ? (
          <Citations citations={message.citations} />
        ) : null}

        {orphan ? (
          <p className="mt-2 text-xs text-amber-600">
            这次提问没有拿到回答（生成失败或被中断）。可以直接重新提问。
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 引用区（2026-10-27 改版）：整体包成 details **默认收起**。
 *
 * 之前常驻展开的两个问题：① 答案下面永远挂着一大块边框盒，对话流被打断；
 * ② summary 行里有"相似度 0.983"—— 那是**评测指标**，对使用者毫无意义，
 * 还占掉整行宽度。相似度数据仍存在快照里，只是不再显示。
 *
 * 摘要行只回答一个问题：引用了几个片段、来自哪些文档。
 */
function Citations({ citations }: { citations: Citation[] }) {
  const docTitles = [...new Set(citations.map((c) => c.documentTitle))];

  return (
    <details className="mt-2 rounded-lg border border-dashed border-zinc-300">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs text-zinc-500 hover:text-zinc-800">
        引用 {citations.length} 段（来自 {docTitles.join('、')}）
      </summary>
      <ul className="flex flex-col gap-2 px-3 pb-3">
        {citations.map((c, i) => (
          <CitationItem key={`${c.documentId}-${c.chunkIndex}`} citation={c} index={i} />
        ))}
      </ul>
    </details>
  );
}

/**
 * 引用条目。
 *
 * 关键点（spec B2）：展示的 content 是**服务端本次真正喂进 Prompt 的那份文本**，
 * 由流的第一行带过来，不是前端拿 documentId 再查一次库。
 * 重新查库的话，文档在这期间被改过就会显示"引用里没有的内容"——
 * 那正是"幻觉引用"最难被发现的一种形态。
 *
 * 历史回答里的引用之所以几个月后还能点开（spec A3），是因为落库存的就是这份快照，
 * 而不是 chunkId 外键。
 */
function CitationItem({ citation, index }: { citation: Citation; index: number }) {
  const preview = citation.content.slice(0, 60);

  return (
    <li className="text-xs">
      {/* details/summary：展开状态由浏览器管，不需要额外 state */}
      <details>
        <summary className="cursor-pointer text-zinc-600 hover:text-zinc-900">
          <span className="font-medium text-zinc-900">[{index + 1}]</span> {citation.documentTitle} ·
          第 {citation.chunkIndex + 1} 段
          <span className="ml-2 text-zinc-400">{preview}……</span>
        </summary>
        <p className="mt-2 whitespace-pre-wrap rounded bg-zinc-50 p-3 leading-6 text-zinc-700">
          {citation.content}
        </p>
      </details>
    </li>
  );
}
