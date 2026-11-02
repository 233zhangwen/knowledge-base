'use server';

import { revalidatePath } from 'next/cache';
import { cookies, headers } from 'next/headers';

import { createInvite, consumeInvite } from '@/lib/invite';
import { prisma } from '@/lib/prisma';
import { can } from '@/lib/permissions';
import { ACTIVE_ORG_COOKIE, requireTenant } from '@/lib/session';

/**
 * 设置页的四个动作：切换活动组织 / 生成邀请 / 移除成员 / 消费邀请。
 * 消费邀请的入口在 /invite/[token] 页，但逻辑集中放在这里 ——
 * 邀请相关的东西散在两个文件里，迟早出现"这边改了提示语那边没改"。
 */

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 一年。cookie 只是个"上次选了谁"的偏好，过期了走 fallback，无安全问题

/**
 * 切换活动组织。
 *
 * 为什么这里还要查一次 membership：表单里的 orgId 是客户端传来的。
 * 不验证的话，任何人构造一个 POST 就能把自己 cookie 写成任何组织 ——
 * 虽然 requireTenant 每次请求还会再验一遍（伪造的 cookie 进不了数据），
 * 但"入口不写脏数据"和"读取时兜底"是两道独立的闸，都要有。
 */
export async function switchOrg(formData: FormData): Promise<void> {
  const { userId } = await requireTenant();

  const orgId = String(formData.get('orgId') ?? '');
  if (!orgId) return;

  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: { id: true },
  });
  if (!membership) return;

  const store = await cookies();
  store.set(ACTIVE_ORG_COOKIE, orgId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  });

  // layout 级 revalidate：/kb、/kb/[id] 都要换成新组织的数据
  revalidatePath('/', 'layout');
}

export type InviteState = { error?: string; link?: string; expiresLabel?: string };

/** 生成一条邀请，把完整链接回给 owner 复制。明文 token 只在这里出现这一次。 */
export async function createInviteAction(
  _prev: InviteState,
  _formData: FormData,
): Promise<InviteState> {
  const { userId, orgId, role } = await requireTenant();

  if (!can({ userId, role }, 'invite:create')) {
    return { error: '只有组织所有者能生成邀请链接' };
  }

  const { token, expiresAt } = await createInvite({ orgId, createdBy: userId });

  // host 从请求头拼：Server Action 里拿不到"应用自己的域名"配置，请求头就是事实来源
  const h = await headers();
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const host = h.get('host') ?? 'localhost:3000';

  return {
    link: `${proto}://${host}/invite/${token}`,
    expiresLabel: expiresAt.toLocaleDateString('zh-CN'),
  };
}

export type JoinState = { error?: string; joinedOrg?: string };

/** 消费邀请（/invite/[token] 页的"加入组织"按钮）。 */
export async function joinInviteAction(
  _prev: JoinState,
  formData: FormData,
): Promise<JoinState> {
  const { userId } = await requireTenant();

  const token = String(formData.get('token') ?? '');
  if (!token) {
    return { error: '邀请链接不完整' };
  }

  const result = await consumeInvite(token, userId);

  if (!result.ok) {
    const messages = {
      INVALID: '邀请链接无效',
      USED: '这条邀请已经被使用过了',
      EXPIRED: '邀请已过期，请联系组织所有者重新生成',
      ALREADY_MEMBER: '你已经是这个组织的成员',
    } as const;
    return { error: messages[result.reason] };
  }

  // 加入成功后把活动组织切到新组织 —— 用户接下来打开 /kb 看到的就是新家的数据，
  // 否则会出现"加入了却看不到新组织"的困惑（正是 W19 遗留账①说的那种静默）。
  const store = await cookies();
  store.set(ACTIVE_ORG_COOKIE, result.orgId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  });

  const org = await prisma.organization.findUnique({
    where: { id: result.orgId },
    select: { name: true },
  });

  revalidatePath('/', 'layout');

  return { joinedOrg: org?.name ?? '新组织' };
}

export type RemoveState = { error?: string };

/** 移除成员。owner 专属；只能移除 role=member 的人，也不能移除自己。 */
export async function removeMemberAction(
  _prev: RemoveState,
  formData: FormData,
): Promise<RemoveState> {
  const { userId, orgId, role } = await requireTenant();

  if (!can({ userId, role }, 'member:remove')) {
    return { error: '只有组织所有者能移除成员' };
  }

  const memberId = String(formData.get('membershipId') ?? '');
  if (!memberId) {
    return { error: '缺少成员标识' };
  }

  const target = await prisma.membership.findFirst({
    where: { id: memberId, orgId },
    select: { userId: true, role: true },
  });
  // 不区分"不存在"和"无权"的提示细节，防止用返回信息枚举 membership id
  if (!target) {
    return { error: '成员不存在或无权移除' };
  }
  if (target.userId === userId) {
    return { error: '不能移除自己' };
  }
  if (target.role !== 'member') {
    // 本期邀请只发 member，正常到不了这里；防御性保留 ——
    // 等将来出现"多个 owner"，没有这条就会出现"owner 互踢"。
    return { error: '不能移除组织所有者' };
  }

  await prisma.membership.delete({ where: { id: memberId } });

  revalidatePath('/settings');

  return {};
}
