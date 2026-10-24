'use client';

import { useActionState } from 'react';

import { reindexDocument, type ActionState } from './actions';

/**
 * 重建索引按钮。和删除不同，这里**不需要二次确认**：
 * 重建是幂等操作（indexDocument 内部先删旧 chunks 再写新的），
 * 最坏结果是"重建后还是老样子"，不会丢数据 —— 破坏性操作的确认交互，
 * 只该给真正不可逆的动作留着。
 */
export function ReindexButton({ id }: { id: string }) {
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    reindexDocument,
    {},
  );

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="id" value={id} />

      {state.error ? <span className="text-xs text-red-600">{state.error}</span> : null}

      <button
        type="submit"
        disabled={isPending}
        className="rounded-md border px-3 py-1.5 text-sm text-zinc-600 hover:border-blue-300 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isPending ? '索引中…' : '重建索引'}
      </button>
    </form>
  );
}
