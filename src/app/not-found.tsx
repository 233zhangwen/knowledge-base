/**
 * 404 页。
 *
 * 默认的 Next 404 是英文 "This page could not be found."，
 * 对一个中文界面 + 作品集站点来说，最该说清的是：
 * "链接可能失效了，但东西还在，从这里回去"。
 */
import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-lg font-semibold">页面不存在</h1>
      <p className="text-sm text-zinc-500">
        链接可能已经失效，或者这条内容不属于当前账号。
      </p>
      <Link
        href="/kb"
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
      >
        回知识库列表
      </Link>
    </main>
  );
}
