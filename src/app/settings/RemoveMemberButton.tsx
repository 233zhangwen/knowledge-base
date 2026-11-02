'use client';

import { useActionState, useState } from 'react';

import { removeMemberAction, type RemoveState } from './actions';

/**
 * 移除成员按钮。两段确认与 DeleteDocumentButton 同款 ——
 * 破坏性操作的确认交互在整个应用里只有一种写法，不发明第二种。
 */
export function RemoveMemberButton({
  membershipId,
  memberName,
}: {
  membershipId: string;
  memberName: string;
}) {
  const [state, formAction, isPending] = useActionState<RemoveState, FormData>(
    removeMemberAction,
    {},
  );
  const [confirming, setConfirming] = useState(false);

  if (state.error) {
    // 移除失败直接平铺显示（例如"不能移除自己"），不需要重试入口
    return <span className="text-xs text-red-600">{state.error}</span>;
  }

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="membershipId" value={membershipId} />

      {confirming ? (
        <>
          <button
            type="submit"
            disabled={isPending}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isPending ? '移除中…' : `确认移除 ${memberName}`}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={isPending}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-60"
          >
            取消
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="rounded-md border px-3 py-1.5 text-sm text-zinc-600 hover:border-red-300 hover:text-red-600"
        >
          移除
        </button>
      )}
    </form>
  );
}
