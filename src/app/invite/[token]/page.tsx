import { createHash } from 'node:crypto';

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';

import { GithubSignInButton } from '../../login/GithubSignInButton';
import { JoinButton } from './JoinButton';

/**
 * 邀请落地页 /invite/[token]（W20）。
 *
 * 三种状态，一一对应访问者的处境：
 *   未登录 → 提示先登录（登录后 callbackUrl 回到本页，token 在 URL 里不丢）
 *   token 无效/已用/已过期 → 明说原因，不给"加入"按钮
 *   有效 → 显示组织名 + 加入按钮
 *
 * 为什么"加入"是按钮而不是打开页面自动入组：
 *   GET 请求不该有副作用（这是 HTTP 的语义，不是风格偏好）——
 *   邮件客户端、聊天软件的链接预览爬虫会主动 GET 一次链接，
 *   自动消费会让"预览"直接烧掉这条一次性邀请。
 */
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const session = await auth();

  if (!session?.user) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-8">
        <h1 className="text-xl font-semibold">先登录，再加入组织</h1>
        <p className="text-sm text-zinc-500">
          登录后会回到这个页面，继续完成加入。
        </p>
        <GithubSignInButton callbackUrl={`/invite/${token}`} />
      </main>
    );
  }

  // 用 hash 查邀请，带出组织名给用户确认"我要加入的是谁"
  const invite = await prisma.invite.findFirst({
    where: { tokenHash: createHash('sha256').update(token).digest('hex') },
    select: {
      consumedAt: true,
      expiresAt: true,
      org: { select: { name: true } },
    },
  });

  const invalid = !invite || invite.consumedAt || invite.expiresAt <= new Date();

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-8">
      {invalid ? (
        <>
          <h1 className="text-xl font-semibold">邀请链接不可用</h1>
          <p className="text-sm text-zinc-500">
            {!invite
              ? '链接不存在或已被撤销。'
              : invite.consumedAt
                ? '这条邀请已经被使用过了（每条链接只能用一次）。'
                : '链接已过期，请联系组织所有者重新生成。'}
          </p>
        </>
      ) : (
        <>
          <h1 className="text-xl font-semibold">加入「{invite.org.name}」</h1>
          <p className="text-sm text-zinc-500">
            加入后可以看到该组织共享的知识库。你将以成员身份加入。
          </p>
          <JoinButton token={token} />
        </>
      )}
    </main>
  );
}
