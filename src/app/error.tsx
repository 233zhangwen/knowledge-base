'use client';

/**
 * 全局错误边界（App Router 的 error.tsx）。
 *
 * 没有它的时候，任何一个 Server Component 抛错，用户看到的是 Next 的
 * 默认错误页 —— 生产环境（Next 16 production）只显示一句
 * "Application error: a server-side exception has occurred"，连"重试"
 * 都没有，用户只能刷新，而且刷完还是同一个错。
 *
 * 这里做三件事：
 *   1. 说人话（中文）+ 给一个 digest，方便用户报给我们时对上服务端日志；
 *   2. 给"重试"按钮（reset 会重新渲染那一段，不是整页刷新）；
 *   3. 给"回首页"出口 —— 出错页面往往是最需要退路的地方。
 *
 * 注意：error.tsx 必须是 client component，且**不能**捕获根 layout 里的错
 * （那种要靠 global-error.tsx）；我们的错误基本都发生在页面层，够用。
 */
import Link from 'next/link';
import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 服务端日志里同时能看到这条（reportError 内部会打 error 日志），两边用 digest 对上
    console.error('[app] 页面渲染失败', error);

    // W13：上报到 /api/errors 落库，进 /admin 可见。
    // 用 sendBeacon 而不是 fetch：用户很可能在错误页直接关标签页，
    // fetch 会在页面销毁时被取消，beacon 交给浏览器发完。
    // beacon 不支持自定义 header，所以用 Blob 指定 content-type。
    const payload = JSON.stringify({
      event: 'client.render.error',
      message: error.message || '页面渲染失败',
      stack: error.stack,
      path: window.location.pathname,
      digest: error.digest,
    });
    if (!navigator.sendBeacon?.('/api/errors', new Blob([payload], { type: 'application/json' }))) {
      // beacon 被浏览器拒绝（极少见）时退回 fetch，失败就算了 —— 上报不能影响用户
      void fetch('/api/errors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      }).catch(() => {});
    }
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-lg font-semibold">这个页面出错了</h1>
      <p className="text-sm text-zinc-500">
        可能是网络波动或服务暂时不可用。你可以先重试一次，不行再回知识库列表。
      </p>
      {error.digest ? (
        <p className="text-xs text-zinc-400">错误编号：{error.digest}</p>
      ) : null}
      <div className="flex gap-3">
        <button
          onClick={reset}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
        >
          重试
        </button>
        <Link
          href="/kb"
          className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800"
        >
          回知识库列表
        </Link>
      </div>
    </main>
  );
}
