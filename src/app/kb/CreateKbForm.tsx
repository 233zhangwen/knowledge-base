'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import { createKnowledgeBase, type ActionState } from './actions';

/**
 * 新建知识库表单。
 *
 * 用 React 19 的 useActionState（不是已废弃的 useFormState）：
 *   const [state, formAction, isPending] = useActionState(action, initialState)
 * 第三个返回值 isPending 直接拿来做按钮 loading，不用再引 useFormStatus。
 *
 * ⚠️ 关于"提交后自动清空"：以前这里写的是"uncontrolled 表单会被 React 自动 reset，
 * 不用手动清空" —— 只对了一半。自动 reset **不分成功失败都会执行**，
 * 所以一旦创建失败（比如描述超过 200 字），用户刚打的两行字会被一起清空。
 * 改成受控输入后：成功时我们用 wasPending 手动清，失败时内容原地保留。
 */
export function CreateKbForm() {
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    createKnowledgeBase,
    {},
  );

  const [fields, setFields] = useState({ name: '', description: '' });

  /** 只在成功时清空：从 pending 变回非 pending，且没有报错。 */
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !isPending && !state.error) {
      setFields({ name: '', description: '' });
    }
    wasPending.current = isPending;
  }, [isPending, state]);

  return (
    <form action={formAction} className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="kb-name" className="text-sm font-medium">
          名称
        </label>
        <input
          id="kb-name"
          name="name"
          value={fields.name}
          onChange={(e) => setFields((f) => ({ ...f, name: e.target.value }))}
          required
          maxLength={50}
          placeholder="例如：前端面试题"
          className="rounded-md border px-3 py-2 text-sm outline-none focus:border-zinc-900"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="kb-description" className="text-sm font-medium">
          描述（选填）
        </label>
        <input
          id="kb-description"
          name="description"
          value={fields.description}
          onChange={(e) => setFields((f) => ({ ...f, description: e.target.value }))}
          maxLength={200}
          placeholder="这个知识库装的是什么"
          className="rounded-md border px-3 py-2 text-sm outline-none focus:border-zinc-900"
        />
      </div>

      {state.error ? <p className="text-sm text-red-600">{state.error}</p> : null}

      <button
        type="submit"
        disabled={isPending}
        className="self-start rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isPending ? '创建中…' : '新建知识库'}
      </button>
    </form>
  );
}
