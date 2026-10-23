'use client';

import { signIn } from 'next-auth/react';
import { useState } from 'react';

/**
 * 用客户端 signIn，而不是 Server Action。
 *
 * 为什么：
 *   在 Server Action 里 `await signIn('github')` 会 throw NEXT_REDIRECT，
 *   Next 把它作为 `x-action-redirect` 响应头发回客户端，由**客户端路由器**执行跳转。
 *   但跳转目标是外站（github.com），实测 Next 16.4.2 + Turbopack dev 下
 *   这次跨站导航没有执行 —— 表现为「点了按钮毫无反应」，而服务端其实已经把
 *   正确的 github 授权地址算好了（用 curl 模拟 form POST 能看到 303）。
 *
 *   客户端 signIn 走的是浏览器自己的 fetch + window.location，
 *   不经过 Next 的客户端路由器，所以稳。
 *
 *   顺带的好处：这样还能给 loading 态，避免用户重复点击。
 */
export function GithubSignInButton() {
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        setPending(true);
        // callbackUrl：登录成功后跳回哪里。Auth.js 会校验它是不是同源地址。
        void signIn('github', { callbackUrl: '/kb' });
      }}
      className="rounded-md bg-zinc-900 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? '正在跳转到 GitHub…' : '使用 GitHub 登录'}
    </button>
  );
}
