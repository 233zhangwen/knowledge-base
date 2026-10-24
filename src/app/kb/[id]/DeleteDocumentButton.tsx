'use client';

import { useActionState, useState } from 'react';

import { deleteDocument, type ActionState } from './actions';

const DELETE_BTN =
  'rounded-md border px-3 py-1.5 text-sm text-zinc-600 hover:border-red-300 hover:text-red-600';

export function DeleteDocumentButton({ id }: { id: string }) {
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    deleteDocument,
    {},
  );
  const [confirming, setConfirming] = useState(false);

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="id" value={id} />

      {state.error ? <span className="text-xs text-red-600">{state.error}</span> : null}

      {confirming ? (
        <>
          <button
            type="submit"
            disabled={isPending}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isPending ? '删除中…' : '确认删除'}
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
        <button type="button" onClick={() => setConfirming(true)} className={DELETE_BTN}>
          删除
        </button>
      )}
    </form>
  );
}
