'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { joinInviteAction, type JoinState } from '../../settings/actions';

export function JoinButton({ token }: { token: string }) {
  const [state, formAction, isPending] = useActionState<JoinState, FormData>(
    joinInviteAction,
    {},
  );

  if (state.joinedOrg) {
    return (
      <div className="flex flex-col items-center gap-3">
        <p className="text-sm text-emerald-600">
          已加入「{state.joinedOrg}」，当前活动组织已切换。
        </p>
        <Link
          href="/kb"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-700"
        >
          去知识库
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col items-center gap-2">
      <input type="hidden" name="token" value={token} />
      {state.error ? <p className="text-sm text-red-600">{state.error}</p> : null}
      <button
        type="submit"
        disabled={isPending}
        className="rounded-md bg-zinc-900 px-6 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isPending ? '加入中…' : '加入组织'}
      </button>
    </form>
  );
}
