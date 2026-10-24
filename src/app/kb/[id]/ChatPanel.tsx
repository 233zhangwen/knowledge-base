'use client';

/**
 * 问答面板：提问 → 流式读答案 → 展示引用。
 *
 * 这一层是 W4 唯一「前端自己读流」的地方。服务端 llm.ts 读一遍上游的 SSE，
 * 这里再读一遍下游的字节流，两段代码是同一个模式：
 *   getReader() → while(read()) → 累积 → 交给协议解析器切出可用部分
 * 看懂一段，另一段就是同一套。
 *
 * 为什么不用 `<form action={serverAction}>`：
 *   ① 要读流式响应，必须自己 fetch；
 *   ② React 19 会在 action 完成后自动 reset 表单（见 RenameForm 注释），
 *      而这里失败时恰恰要保留用户刚打的问题。受控 textarea 才守得住。
 */
import { useRef, useState } from 'react';

import {
  createCursor,
  feed,
  type Citation,
  type StreamCursor,
} from '@/lib/chat-protocol';

/** 与 route.ts 里的 MAX_QUESTION_LENGTH 一致：前端先拦，省一次往返。 */
const MAX_QUESTION_LENGTH = 1000;

type Phase = 'idle' | 'streaming' | 'done' | 'error';

export function ChatPanel({ kbId, disabled }: { kbId: string; disabled?: boolean }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState<Citation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const abortRef = useRef<AbortController | null>(null);

  const isStreaming = phase === 'streaming';

  async function ask() {
    const q = question.trim();
    if (!q || isStreaming) return;

    setAnswer('');
    setCitations([]);
    setError(null);
    setPhase('streaming');

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`/api/kb/${kbId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
        signal: controller.signal,
      });

      // 鉴权 / 归属 / 参数错误在这里就返回了，还没进流
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `请求失败（HTTP ${res.status}）`);
        setPhase('error');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const cursor: StreamCursor = createCursor();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const parsedHeader = feed(cursor, decoder.decode(value, { stream: true }));
        if (parsedHeader) setCitations(cursor.citations);
        setAnswer(cursor.answer);
        if (cursor.errorMode) setError(cursor.error);
      }

      if (cursor.errorMode) {
        // 错误信息可能到流末尾才收全，这里用最终值兜一次
        setError(cursor.error.trim() || '生成失败');
        setPhase('error');
      } else {
        setPhase('done');
      }
    } catch (e) {
      // 用户主动停止：保留已经生成的部分，不算错误
      if (e instanceof DOMException && e.name === 'AbortError') {
        setPhase('done');
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    } finally {
      abortRef.current = null;
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-zinc-500">提问</h2>

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
            placeholder="基于这个知识库的内容提问……（Ctrl + Enter 发送）"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
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
                onClick={() => abortRef.current?.abort()}
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

          {answer || isStreaming ? (
            <div className="rounded-lg border p-4">
              <p className="mb-2 text-xs text-zinc-400">回答</p>
              {/* pre-wrap：模型输出里的换行要原样呈现，否则段落糊成一团 */}
              <p className="whitespace-pre-wrap text-sm leading-7">
                {answer}
                {isStreaming ? <span className="text-zinc-400">▌</span> : null}
              </p>
            </div>
          ) : null}

          {citations.length > 0 ? (
            <div className="rounded-lg border p-4">
              <p className="mb-2 text-xs text-zinc-400">
                引用（本次召回的 {citations.length} 个片段，点开看全文）
              </p>
              <ul className="flex flex-col gap-2">
                {citations.map((c, i) => (
                  <CitationItem key={`${c.documentId}-${c.chunkIndex}`} citation={c} index={i} />
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * 引用条目。
 *
 * 关键点（spec B2）：展示的 content 是**服务端本次真正喂进 Prompt 的那份文本**，
 * 由流的第一行带过来，不是前端拿 documentId 再查一次库。
 * 重新查库的话，文档在这期间被改过就会显示"引用里没有的内容"——
 * 那正是"幻觉引用"最难被发现的一种形态。
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
          <span className="ml-2 text-zinc-400">相似度 {citation.similarity.toFixed(3)}</span>
          <span className="ml-2 text-zinc-400">{preview}……</span>
        </summary>
        <p className="mt-2 whitespace-pre-wrap rounded bg-zinc-50 p-3 leading-6 text-zinc-700">
          {citation.content}
        </p>
      </details>
    </li>
  );
}
