'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import { deleteKnowledgeBase, renameKnowledgeBase, type ActionState } from './actions';

type KnowledgeBaseCardProps = {
  id: string;
  name: string;
  description: string | null;
  documentCount: number;
  /** 在服务端格式化好再传进来。客户端再格式化容易和 SSR 结果不一致，触发 hydration 警告。 */
  createdAtLabel: string;
};

export function KbCard({
  id,
  name,
  description,
  documentCount,
  createdAtLabel,
}: KnowledgeBaseCardProps) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      {editing ? (
        /**
         * 拆成独立组件不是为了好看，是为了**让 state 跟着一起销毁**。
         * useActionState 没有官方的 reset 方法，它的 state 会一直留着。
         * 以前取消编辑只是 setEditing(false)，组件没卸载 → 下次再进编辑态，
         * 上一次的红色报错还挂在下面（用户看到一条不属于本次操作的错误）。
         * 放进子组件后：退出编辑 = 组件卸载 = state 一起没了；再进来是全新的一份。
         */
        <RenameForm id={id} name={name} onDone={() => setEditing(false)} />
      ) : (
        <>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-medium">{name}</h2>
              {description ? (
                <p className="mt-1 text-sm text-zinc-500">{description}</p>
              ) : null}
              <p className="mt-2 text-xs text-zinc-400">
                {documentCount} 个文档 · 创建于 {createdAtLabel}
              </p>
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-zinc-100"
            >
              重命名
            </button>

            {confirming ? (
              <DeleteConfirm
                id={id}
                documentCount={documentCount}
                onCancel={() => setConfirming(false)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="rounded-md border px-3 py-1.5 text-sm text-zinc-600 hover:border-red-300 hover:text-red-600"
              >
                删除
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

type RenameFormProps = {
  id: string;
  name: string;
  onDone: () => void;
};

function RenameForm({ id, name, onDone }: RenameFormProps) {
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    renameKnowledgeBase,
    {},
  );

  /**
   * ⚠️ 这里必须是**受控**输入（value + onChange），不能用 defaultValue。
   *
   * React 19 有一条容易忽略的行为：表单用 action 提交完成后，React 会自动
   * form.reset()，非受控字段被还原成 defaultValue。对成功场景是好事（不用手动清），
   * 但对失败场景是个 bug —— 用户改了 60 个字 → 提交 → 报"不能超过 50 个字"
   * → 输入框里的 60 个字已经被清空了。报错的同时把用户输入也毁了，
   * 用户只能从头再打一遍。
   *
   * 改成受控之后，显示什么由这个 state 决定，form.reset() 影响不到它。
   */
  const [value, setValue] = useState(name);

  /**
   * 保存成功后自动退出编辑态。
   * useActionState 只给"当前状态"，没有"刚刚提交完"这个事件，
   * 所以用 ref 记住上一次的 isPending：从 true 变 false 且没有报错 = 成功了。
   */
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !isPending && !state.error) {
      onDone();
    }
    wasPending.current = isPending;
  }, [isPending, state, onDone]);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
      <input
        name="name"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={50}
        autoFocus
        className="rounded-md border px-3 py-2 text-sm outline-none focus:border-zinc-900"
      />
      {state.error ? <p className="text-sm text-red-600">{state.error}</p> : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isPending ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-zinc-100"
        >
          取消
        </button>
      </div>
    </form>
  );
}

type DeleteConfirmProps = {
  id: string;
  documentCount: number;
  onCancel: () => void;
};

function DeleteConfirm({ id, documentCount, onCancel }: DeleteConfirmProps) {
  /**
   * 删除必须走 useActionState（而不是直接 action={deleteKnowledgeBase}），
   * 两个理由：
   *   1. 要拿到 isPending 做 disabled —— 否则慢网下连点两次会提交两个请求，
   *      第二次删的是已经不存在的 id，返回 0 行，静默失败。
   *   2. 要拿到 state.error —— 这条记录已经被别处删掉（或 id 被改过）时，
   *      deleteMany 会返回 0 行，必须告诉用户"没删掉"，
   *      而不是让他好奇地再点一次。
   */
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    deleteKnowledgeBase,
    {},
  );

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="id" value={id} />

      {state.error ? (
        <span className="text-xs text-red-600">{state.error}</span>
      ) : (
        <span className="text-xs text-zinc-500">
          将同时删除 {documentCount} 个文档及其切片，不可恢复
        </span>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isPending ? '删除中…' : '确认删除'}
      </button>

      {/* 删除过程中也禁用取消：请求还在飞的时候把表单收起来，
          用户会以为取消了、其实删成功了一半状态，这是自找的目标不一致。 */}
      <button
        type="button"
        onClick={onCancel}
        disabled={isPending}
        className="rounded-md border px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-60"
      >
        取消
      </button>
    </form>
  );
}
