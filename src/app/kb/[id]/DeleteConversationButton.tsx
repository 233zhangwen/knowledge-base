'use client';

/**
 * 单条会话的删除按钮（2026-10-27 新增；2026-10-29 图标化改版）。
 *
 * 交互仍是 DeleteDocumentButton 同款两步确认：灰图标 → 变红色"确认 + 取消" →
 * 再点确认才真正提交。删的是整段对话历史，误触代价高，一步直删太危险。
 * 红色只在确认那一步出现 —— 之前每行常驻红色"删除"两个字，四个会话四团红，
 * 警示色就失去警示意义了。
 *
 * 2026-10-29 可见性策略（悬停浮现的代价要付清）：
 *   · 桌面：默认 opacity-0，行悬停（group-hover/row）才浮现 —— 降噪音；
 *   · 键盘：focus-within 也浮现（Tab 进来必须看得见）；
 *   · 触屏：pointer:coarse 没有 hover → 常显（灰色图标不刺眼）；
 *   · opacity-0 但仍可点击是隐藏 bug（看不见的按钮拦截点击），
 *     所以 pointer-events 必须和 opacity 成对切换。
 *
 * 和 DeleteDocumentButton 的关键差异在**成功后的跳转**：
 *   · 删的是正在看的会话（active）→ 跳回 /kb/[id]（新对话视图），
 *     否则 URL 里的 ?c= 指向一条已删除的会话；
 *   · 删的是别的会话 → router.refresh() 让侧栏重查列表即可。
 *
 * 为什么不能在 action 成功后直接跳：useActionState 拿不到"刚刚成功"这个时机 ——
 * 用 wasPending 标记（isPending true→false 的一次跃迁）判定"这一轮 action 刚结束"，
 * 再根据有无 error 决定跳转。这个套路 RenameForm 用的同款。
 */
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, useState } from 'react';

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
  /**
   * "这一轮 action 刚结束"的标记用 ref 而不是 state（W13 lint 修复）。
   *
   * 原来用 useState + effect 里 setState：React 的新 lint 规则会直接报
   * `set-state-in-effect`（同步 setState 触发级联渲染）。这个标记本来就不是
   * 用来渲染的 —— 它只是"上一次是否在 pending"的备忘，ref 才是它的正确归属。
   * 行为等价：effect 仍然在 isPending 由 true 变 false 的那一次执行跳转。
   */
  const wasPendingRef = useRef(false);
  const router = useRouter();

  useEffect(() => {
    if (isPending) {
      wasPendingRef.current = true;
      return;
    }
    if (!wasPendingRef.current) return;
    wasPendingRef.current = false;
    if (state.error) return;

    if (active) {
      router.push(`/kb/${kbId}`);
    } else {
      router.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPending]);

  /**
   * 确认中（或出错）时必须始终可见 —— 否则鼠标一离开行，
   * 红色"确认"就消失，用户根本没法点第二次。
   */
  const alwaysVisible = confirming || isPending || Boolean(state.error);
  const visibility = alwaysVisible
    ? ''
    : 'opacity-0 pointer-events-none transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100 [@media(pointer:coarse)]:pointer-events-auto [@media(pointer:coarse)]:opacity-100';

  return (
    <form
      action={formAction}
      className={`absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 ${visibility}`}
    >
      <input type="hidden" name="id" value={id} />

      {confirming ? (
        <>
          <button
            type="submit"
            data-testid="delete-conversation-confirm"
            disabled={isPending}
            className="rounded bg-white px-1.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-60"
          >
            {isPending ? '删除中…' : '确认'}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={isPending}
            className="rounded bg-white px-1.5 py-1 text-xs text-zinc-400 hover:text-zinc-600 disabled:opacity-60"
          >
            取消
          </button>
        </>
      ) : (
        <button
          type="button"
          data-testid="delete-conversation"
          onClick={() => setConfirming(true)}
          aria-label="删除会话"
          title="删除"
          className="rounded p-1 text-zinc-400 hover:text-red-600"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8h5.6l.7-8M6.7 7v3.5M9.3 7v3.5" />
          </svg>
        </button>
      )}

      {/* 行高有限，错误信息截断显示；完整语义是"这次删除没成功，会话还在"。
          绝对定位挂在按钮组下方，不挤占行内空间 */}
      {state.error ? (
        <span className="absolute right-0 top-full mt-0.5 max-w-[140px] truncate rounded bg-white px-1 text-xs text-red-600">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
