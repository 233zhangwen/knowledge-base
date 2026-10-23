import { redirect } from 'next/navigation';

import { auth } from '@/auth';

import { GithubSignInButton } from './GithubSignInButton';

export default async function LoginPage() {
  // 已登录就别停留在登录页
  const session = await auth();
  if (session?.user) {
    redirect('/kb');
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-8">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold">个人知识库问答</h1>
        <p className="text-sm text-zinc-500">登录后即可创建知识库、上传文档并提问</p>
      </div>

      {/* 登录按钮必须是 Client Component，原因写在 GithubSignInButton.tsx 里 */}
      <GithubSignInButton />
    </main>
  );
}
