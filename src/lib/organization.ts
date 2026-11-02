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

/**
 * 解析用户的"活动组织"（W20）。
 *
 * 为什么 cookie 里的 orgId 不能直接信：cookie 是客户端可改的。
 * 把别人的 orgId 写进自己的 cookie，如果直接拿来查业务表，就是一次完整的跨租户访问。
 * 所以这里必须拿它去查**自己的** membership —— 查不到就当没提供过，走 fallback。
 * 这一步查库就是防伪造的全部，一次几毫秒，和 requireTenant 查角色的代价是同一次。
 *
 * 为什么独立成函数、requireTenant 不直接写：这个函数只依赖 userId 和 cookie 值，
 * 不碰 session / cookies()，DB 测试可以直打它（伪造 cookie 的场景不用起 HTTP 服务）。
 *
 * 没有任何 membership 时抛 NO_ORGANIZATION，由调用方决定兜底
 * （requireTenant 里是 ensureOrganization，测试里直接断言异常）。
 */
export async function resolveActiveOrg(
  userId: string,
  cookieOrgId: string | undefined,
): Promise<{ orgId: string; role: string }> {
  if (cookieOrgId) {
    const active = await prisma.membership.findUnique({
      where: { userId_orgId: { userId, orgId: cookieOrgId } },
      select: { orgId: true, role: true },
    });
    if (active) {
      return active;
    }
  }

  // 无 cookie / cookie 指向非成员组织 → fallback 最早加入的组织（W19 的原行为）。
  // 这是合理的静默：用户被移出组织后 cookie 失效，落回自己的组织，而不是报错卡死。
  const fallback = await prisma.membership.findFirst({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: { orgId: true, role: true },
  });

  if (!fallback) {
    throw new Error('NO_ORGANIZATION');
  }

  return fallback;
}
