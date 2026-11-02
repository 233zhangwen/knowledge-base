'use client';

import { useActionState } from 'react';

import { createInviteAction, type InviteState } from './actions';

/**
 * 生成邀请链接。链接只在本组件的返回状态里出现一次 ——
 * 服务端只存 hash，刷新或离开页面后就再也找不回来（这是设计，不是 bug）。
 */
export function CreateInviteForm() {
  const [state, formAction, isPending] = useActionState<InviteState, FormData>(
    createInviteAction,
    {},
  );

  return (
    <div className="flex flex-col gap-3">
      <form action={formAction}>
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isPending ? '生成中…' : '生成邀请链接'}
        </button>
      </form>

      {state.error ? <p className="text-sm text-red-600">{state.error}</p> : null}

      {state.link ? (
        <div className="flex flex-col gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
          <p className="text-xs text-emerald-700">
            链接 7 天内有效（{state.expiresLabel} 过期），只能使用一次。复制发给对方：
          </p>
          <code className="break-all rounded bg-white px-2 py-1 text-xs text-zinc-800">
            {state.link}
          </code>
        </div>
      ) : null}
    </div>
  );
}
