import { cookies } from 'next/headers';

import { auth } from '@/auth';
import { ensureOrganization, resolveActiveOrg } from '@/lib/organization';

/** 活动组织 cookie 名。值为 orgId，httpOnly，由 settings 的 switchOrg action 写入。 */
export const ACTIVE_ORG_COOKIE = 'activeOrg';

/**
 * 取当前登录用户的 id。所有需要「知道是谁在操作」的地方都走这里。
 *
 * 为什么不直接在每个页面/action 里写 `const session = await auth()`？
 *   1. 统一出口：漏判一次就是一个越权漏洞，抽成函数才可能"只检查一次、到处复用"
 *   2. 返回类型收窄：外面拿到的是 string，不是 `string | undefined`，
 *      编译器会逼你处理不了"没登录"的情况
 *   3. 抛错而不是返回 null：调用方没法"忘了处理"，一漏就炸在明处
 *
 * ⚠️ 铁律：userId 只能从 session 里取，**永远不要信任客户端传来的 userId**。
 *   表单里带一个隐藏的 userId 字段？那等于把权限大门交给用户自己填。
 */
export async function requireUserId(): Promise<string> {
  const session = await auth();

  const userId = session?.user?.id;
  if (!userId) {
    throw new Error('UNAUTHORIZED');
  }

  return userId;
}

/**
 * 当前租户（W19）：登录用户 + 他所属的组织。
 *
 * 为什么所有业务查询都要用 orgId 而不是 userId：
 *   权限边界从「人」抬到「组织」之后，`where: { id, userId }` 这种写法在语义上就错了 ——
 *   它会让同组织的另一个成员看不到这个库。改错的方向有两个，都很安静：
 *     写 userId  → 成员看不到组织的数据（功能缺一半，但没人报"越权"）
 *     漏写条件   → 任何人能看到任何人的数据（不报错，最危险）
 *   所以统一走这里，让"从哪拿租户"只有一个答案。
 *
 * 为什么不把 orgId 塞进 JWT（登录时写一次，之后免查询）：
 *   那等于把权限的撤销权交给时间。用户被移出组织之后，他手里的 token 里还写着旧 orgId，
 *   直到重新登录 —— 而本项目没有"强制下线"能力（jwt 策略的已知代价，见 README）。
 *   查询一次 membership 的代价是几毫秒，换来的是"权限判断永远基于当下的事实"。
 *
 * W20 更新：取「活动组织」而不是无脑取最早组织 —— cookie 里存了用户上一次选的组织。
 * ⚠️ cookie 是客户端可改的，所以 orgId 必须经过 resolveActiveOrg 的 membership 校验
 *    才能信（伪造 cookie 指向别人的组织 → membership 查不到 → fallback，进不去）。
 */
export async function requireTenant(): Promise<{ userId: string; orgId: string; role: string }> {
  const session = await auth();

  const userId = session?.user?.id;
  if (!userId) {
    throw new Error('UNAUTHORIZED');
  }

  const cookieOrgId = (await cookies()).get(ACTIVE_ORG_COOKIE)?.value;

  try {
    const { orgId, role } = await resolveActiveOrg(userId, cookieOrgId);
    return { userId, orgId, role };
  } catch (error) {
    if ((error as Error).message !== 'NO_ORGANIZATION') {
      throw error;
    }
  }

  /**
   * 兜底：signIn 事件是 fire-and-forget（NextAuth v5 的 events 不阻断登录），
   * 万一那次写库失败（DB 抖动、连接池打满），用户会带着一个没有组织的身份进来。
   *
   * 这时候有两种选择：
   *   a) 抛 NO_ORGANIZATION —— 用户卡在登录后，什么都点不了，也看不懂为什么
   *   b) 补建一个 —— 用户正常用，代价是组织名字可能是兜底的"个人 的空间"
   *
   * 选 b。卡死在登录后是最差的结果：它看起来像登录坏了，而真正的原因在别处。
   */
  const orgId = await ensureOrganization({
    id: userId,
    name: session.user?.name,
    email: session.user?.email,
  });

  return { userId, orgId, role: 'owner' };
}
