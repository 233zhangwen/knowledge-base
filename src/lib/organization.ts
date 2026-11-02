// lib 内统一用相对导入（其余 5 处同款），不再用 @/ 别名：
// 这样 node 直跑的脚本/测试（--experimental-transform-types）也能加载本模块，
// ESM 解析钩子只补相对路径的后缀，不解析 tsconfig 的 paths。
import { prisma } from './prisma';

/**
 * 保证用户有一个组织，返回它的 id（W19）。
 *
 * 调用点只有一个：`auth.ts` 的 `signIn` 事件（用户第一次登录时）。
 *
 * 为什么不放在"注册流程"里：本项目只有 GitHub OAuth，没有注册这个动作 ——
 * 用户第一次登录时 User 行已经由适配器写好了。signIn 是唯一可靠的一次性入口。
 *
 * 为什么放在单独文件而不是 session.ts：`auth.ts` 要 import session.ts 里的
 * 东西会很别扭（session.ts 又 import auth.ts 拿 `auth()`），容易绕成循环。
 * 这个函数不依赖会话，只依赖 user 对象，拆出来两边都能用。
 *
 * 幂等：已有成员关系就直接返回。所以每次登录调一次没有副作用，
 * 也不需要"只在首次登录时调用"的判断 —— 那种判断往往写错，而写错的后果是
 * 老用户永远拿不到组织（登录后进不去任何页面）。
 */
export async function ensureOrganization(user: {
  id: string;
  name?: string | null;
  email?: string | null;
}): Promise<string> {
  const existing = await prisma.membership.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
    select: { orgId: true },
  });

  if (existing) {
    return existing.orgId;
  }

  const displayName = user.name || user.email || '个人';

  const org = await prisma.organization.create({
    data: {
      name: `${displayName} 的空间`,
      memberships: {
        create: { userId: user.id, role: 'owner' },
      },
    },
    select: { id: true },
  });

  return org.id;
}
