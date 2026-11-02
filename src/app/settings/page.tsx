/**
 * 组织设置页 /settings（W20）。
 *
 * 三个区块，按权限渐进显示：
 *   ① 我所属的组织 + 切换（所有人）
 *   ② 成员列表 + 移除（owner）
 *   ③ 邀请（owner）：生成链接 + 未过期邀请一览
 *
 * 为什么 member 也能进这个页：看到"我在哪个组织、是什么角色"是每个人的需求，
 * 页面按 can('member:list') 渐进渲染，而不是整页 owner-only ——
 * 后者会让 member 以为页面坏了。
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { can } from '@/lib/permissions';
import { requireTenant } from '@/lib/session';

import { CreateInviteForm } from './CreateInviteForm';
import { RemoveMemberButton } from './RemoveMemberButton';
import { switchOrg } from './actions';

export const metadata: Metadata = { title: '组织设置' };

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }

  const { userId, orgId, role } = await requireTenant();
  const isOwner = can({ userId, role }, 'member:list');

  // 我所属的全部组织（切换列表用）；owner 额外拿成员与有效邀请。
  // 三个查询一起发，页面上没有互相依赖的数据。
  const [myMemberships, members, invites] = await Promise.all([
    prisma.membership.findMany({
      where: { userId },
      include: { org: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    isOwner
      ? prisma.membership.findMany({
          where: { orgId },
          include: { user: { select: { name: true, email: true } } },
          orderBy: { createdAt: 'asc' },
        })
      : Promise.resolve([]),
    isOwner
      ? prisma.invite.findMany({
          where: { orgId, consumedAt: null, expiresAt: { gt: new Date() } },
          orderBy: { createdAt: 'desc' },
          select: { id: true, createdAt: true, expiresAt: true },
        })
      : Promise.resolve([]),
  ]);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 p-8">
      <header className="flex items-center justify-between border-b pb-4">
        <h1 className="text-xl font-semibold">组织设置</h1>
        <Link href="/kb" className="text-sm text-zinc-500 hover:text-zinc-800">
          返回知识库
        </Link>
      </header>

      {/* ① 我的组织 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-zinc-500">我所属的组织</h2>
        <div className="flex flex-col gap-2">
          {myMemberships.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between rounded-lg border border-zinc-200 px-4 py-3"
            >
              <div>
                <span className="text-sm font-medium">{m.org.name}</span>
                <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600">
                  {m.role === 'owner' ? '所有者' : '成员'}
                </span>
                {m.orgId === orgId ? (
                  <span className="ml-2 text-xs text-emerald-600">当前</span>
                ) : null}
              </div>
              {m.orgId === orgId ? null : (
                <form action={switchOrg}>
                  <input type="hidden" name="orgId" value={m.orgId} />
                  <button
                    type="submit"
                    className="rounded-md border px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100"
                  >
                    切换到此组织
                  </button>
                </form>
              )}
            </div>
          ))}
        </div>
      </section>

      {isOwner ? (
        <>
          {/* ② 成员 */}
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-zinc-500">
              成员（{members.length}）
            </h2>
            <div className="flex flex-col gap-2">
              {members.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between rounded-lg border border-zinc-200 px-4 py-3"
                >
                  <div className="text-sm">
                    <span className="font-medium">{m.user.name ?? '未命名'}</span>
                    <span className="ml-2 text-zinc-500">{m.user.email}</span>
                    {m.orgId === orgId && m.role === 'owner' ? (
                      <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600">
                        所有者
                      </span>
                    ) : null}
                  </div>
                  {/* 只对 member 且不是自己 出移除按钮；owner 行没有按钮是有意的 */}
                  {m.role === 'member' && m.userId !== userId ? (
                    <RemoveMemberButton membershipId={m.id} memberName={m.user.name ?? '该成员'} />
                  ) : null}
                </div>
              ))}
            </div>
          </section>

          {/* ③ 邀请 */}
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-zinc-500">邀请成员</h2>
            <CreateInviteForm />
            {invites.length > 0 ? (
              <p className="text-xs text-zinc-500">
                有 {invites.length} 条未使用且未过期的邀请链接（生成时间最近：
                {invites[0].createdAt.toLocaleString('zh-CN')}）。链接只会显示一次，遗失请重新生成。
              </p>
            ) : null}
          </section>
        </>
      ) : (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-zinc-500">邀请成员</h2>
          <p className="text-sm text-zinc-500">只有组织所有者可以邀请新成员。</p>
        </section>
      )}
    </main>
  );
}
