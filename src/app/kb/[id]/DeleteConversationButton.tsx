'use client';

/**
 * 单条会话的删除按钮（2026-10-27 新增）。
 *
 * 交互照搬 DeleteDocumentButton 的两步确认：点「删除」→ 变「确认 + 取消」→
 * 再点确认才真正提交。删的是整段对话历史，误触代价高，一步直删太危险。
 *
 * 和 DeleteDocumentButton 的关键差异在**成功后的跳转**：
 *   删的是侧栏里的会话，页面本身还开着 ——
 *   · 删的是正在看的会话（active）→ 跳回 /kb/[id]（新对话视图），
 *     否则 URL 里的 ?c= 指向一条已删除的会话；
 *   · 删的是别的会话 → router.refresh() 让侧栏重查列表即可，别动用户正在看的聊天区。
 *
 * 为什么不能在 action 成功后直接跳：useActionState 拿不到"刚刚成功"这个时机 ——
 * state 里只有结果没有"变化"。用 wasPending 标记（isPending true→false 的一次跃迁）
 * 判定"这一轮 action 刚结束"，再根据有无 error 决定跳转。这个套路 RenameForm 用的同款。
 */
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';

import { deleteConversation, type ActionState } from './actions';

export function DeleteConversationButton({
  id,
  kbId,
  active,
}: {
  id: string;
  kbId: string;
  active: boolean;
}) {
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    deleteConversation,
    {},
  );
  const [confirming, setConfirming] = useState(false);
  const [wasPending, setWasPending] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (isPending) {
      setWasPending(true);
      return;
    }
    if (!wasPending) return;
    setWasPending(false);
    if (state.error) return;

    if (active) {
      router.push(`/kb/${kbId}`);
    } else {
      router.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPending]);

  return (
    <form action={formAction} className="flex shrink-0 flex-col items-start gap-0.5 pt-1.5">
      <input type="hidden" name="id" value={id} />

      {confirming ? (
        <>
          <button
            type="submit"
            disabled={isPending}
            className="rounded px-1.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-60"
          >
            {isPending ? '删除中…' : '确认'}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={isPending}
            className="rounded px-1.5 py-1 text-xs text-zinc-400 hover:text-zinc-600"
          >
            取消
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="rounded px-1.5 py-1 text-xs text-zinc-400 hover:text-red-600"
        >
          删除
        </button>
      )}

      {/* 行高有限，错误信息截断显示；完整语义是"这次删除没成功，会话还在" */}
      {state.error ? (
        <span className="max-w-[72px] truncate text-xs text-red-600">{state.error}</span>
      ) : null}
    </form>
  );
}
