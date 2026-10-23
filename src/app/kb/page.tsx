import { redirect } from 'next/navigation';

import { auth, signOut } from '@/auth';
import { prisma } from '@/lib/prisma';

import { CreateKbForm } from './CreateKbForm';
import { KbCard } from './KbCard';

export default async function KnowledgeBasePage() {
  const session = await auth();

  /*
   * 即使 proxy.ts 已经拦过一道，这里还要再判一次。
   * 这是纵深防御：proxy 只做「有没有 session cookie」这种粗判断，
   * 真正的身份校验必须在数据读取前做。以后加「知识库归属校验」也是在这一层。
   */
  if (!session?.user) {
    redirect('/login');
  }

  const userId = session.user.id;

  /**
   * ⚠️ where 里一定要带 userId。
   * 少了它，这个页面就会把所有人的知识库都列出来 —— 多用户系统最常见的数据泄露，
   * 而且本地开发只有一个账号时根本看不出来。
   *
   * _count 让 Prisma 顺手把每个知识库的文档数查出来，
   * 避免在列表页对每个卡片单独查一次（N+1 查询）。
   */
  const knowledgeBases = await prisma.knowledgeBase.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { documents: true } },
    },
  });

  return (
    <main className="flex min-h-screen flex-col gap-8 p-8">
      <header className="flex items-center justify-between border-b pb-4">
        <div>
          <h1 className="text-xl font-semibold">我的知识库</h1>
          <p className="text-sm text-zinc-500">
            已登录：{session.user.name ?? session.user.email}
          </p>
        </div>

        <form
          action={async () => {
            'use server';
            await signOut({ redirectTo: '/login' });
          }}
        >
          <button
            type="submit"
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm transition-colors hover:bg-zinc-100"
          >
            退出登录
          </button>
        </form>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-medium text-zinc-500">新建</h2>
        <CreateKbForm />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-medium text-zinc-500">
          全部知识库（{knowledgeBases.length}）
        </h2>

        {knowledgeBases.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 p-12 text-center text-sm text-zinc-500">
            还没有知识库，用上面的表单建一个（空状态也要认真做：它是用户第一次打开时看到的东西）
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {knowledgeBases.map((kb) => (
              <KbCard
                key={kb.id}
                id={kb.id}
                name={kb.name}
                description={kb.description}
                documentCount={kb._count.documents}
                createdAtLabel={kb.createdAt.toLocaleDateString('zh-CN')}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
