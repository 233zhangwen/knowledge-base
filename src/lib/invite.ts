// lib 内统一用相对导入（见 organization.ts 头注）：node 直跑的 DB 测试要加载本模块。
import { createHash, randomBytes } from 'node:crypto';

import { prisma } from './prisma';

/** 邀请有效期。写死而不是配置项：还没有第二个取值的需求。 */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * sha256(token)。不加盐也不需要：token 本身是 256 位随机数，不是人类密码，
 * 字典攻击/彩虹表对它无意义 —— 唯一要防的是"库泄露后直接拿明文重放"，hash 足够。
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 生成一条邀请，返回**明文 token**——它只在这一次存在内存里，落库的是 hash。
 * 调用方（settings 的 server action）把它拼进链接返回给 owner，此后再也查不回来。
 *
 * 32 字节 base64url：22 字符、无特殊字符（不用做 URL 转义）、熵 256 bit，
 * 枚举攻击在数学上不可行，所以不需要限速。
 */
export async function createInvite(input: {
  orgId: string;
  createdBy: string;
  role?: string;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  await prisma.invite.create({
    data: {
      orgId: input.orgId,
      role: input.role ?? 'member',
      tokenHash: hashToken(token),
      createdBy: input.createdBy,
      expiresAt,
    },
    select: { id: true },
  });

  return { token, expiresAt };
}

export type ConsumeResult =
  | { ok: true; orgId: string; role: string }
  | { ok: false; reason: 'INVALID' | 'USED' | 'EXPIRED' | 'ALREADY_MEMBER' };

/**
 * 消费邀请：持 token 的登录用户加入对应组织。
 *
 * 检查顺序不是随便排的：
 *   查不到 → INVALID（token 打错或从未存在）
 *   已消费 → USED（明说比含糊好；注意这是"提示"，不是安全边界）
 *   已过期 → EXPIRED
 *   已是成员 → ALREADY_MEMBER（owner 点了自己组织的链接，不该烧掉 token 也不该报错成加入成功）
 *
 * **真正的安全边界在下面的条件式原子消费**：
 *   updateMany({ where: { id, consumedAt: null } }) 带 count 断言。
 *   用户双击"加入"→ 两个请求并发到达，都通过了上面的"已消费？没有"检查 ——
 *   先查后改在这里必然双过。updateMany 带条件是单条 UPDATE ... WHERE consumedAt IS NULL，
 *   数据库行锁保证只有一个请求 count=1，另一个拿到"链接已被使用"。
 *
 * 顺序上先烧 token 再建 Membership：如果反过来，"加入成功但 token 还有效"留下重放窗口；
 *   烧了 token 但建成员失败（DB 抖动）的最坏结果只是"owner 得重新生成一条邀请"，可接受。
 */
export async function consumeInvite(token: string, userId: string): Promise<ConsumeResult> {
  const now = new Date();

  const invite = await prisma.invite.findFirst({
    where: { tokenHash: hashToken(token) },
    select: { id: true, orgId: true, role: true, consumedAt: true, expiresAt: true },
  });

  if (!invite) {
    return { ok: false, reason: 'INVALID' };
  }
  if (invite.consumedAt) {
    return { ok: false, reason: 'USED' };
  }
  if (invite.expiresAt <= now) {
    return { ok: false, reason: 'EXPIRED' };
  }

  const existing = await prisma.membership.findUnique({
    where: { userId_orgId: { userId, orgId: invite.orgId } },
    select: { id: true },
  });
  if (existing) {
    return { ok: false, reason: 'ALREADY_MEMBER' };
  }

  const claimed = await prisma.invite.updateMany({
    where: { id: invite.id, consumedAt: null },
    data: { consumedAt: now, consumedBy: userId },
  });
  if (claimed.count !== 1) {
    // 并发对手方先一步消费了
    return { ok: false, reason: 'USED' };
  }

  // Membership 的 @@unique([userId, orgId]) 兜底：即使上面有检查遗漏，
  // 第二次 insert 也会被数据库拒绝，而不是造出两条成员记录。
  await prisma.membership.upsert({
    where: { userId_orgId: { userId, orgId: invite.orgId } },
    create: { userId, orgId: invite.orgId, role: invite.role },
    update: {},
  });

  return { ok: true, orgId: invite.orgId, role: invite.role };
}
