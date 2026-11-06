// lib 内统一用相对导入（见 organization.ts 头注）：node 直跑的 DB 测试要加载本模块。
import { prisma } from './prisma';

/** env 没配或配错时的兜底值。必须远大于评测月耗（eval:agent 一次 52 问）。 */
const FALLBACK_QUOTA = 500;

/**
 * 配额超限。route 层捕获它翻译成 429，DB 测试直接断言这个类型。
 * 不用字符串 message 判断错误种类 —— 类型和实例判断不会拼错。
 */
export class QuotaExceeded extends Error {
  constructor(
    public readonly used: number,
    public readonly limit: number,
  ) {
    super(`QUOTA_EXCEEDED: ${used}/${limit}`);
    this.name = 'QuotaExceeded';
  }
}

/** 月初（UTC 自然月）。取舍记录在 ACCEPTANCE-W21 D1：不做时区配置。 */
export function monthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function defaultQuota(): number {
  const raw = Number(process.env.MONTHLY_ANSWER_QUOTA);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : FALLBACK_QUOTA;
}

/** 组织的实际额度：DB 字段优先（null = 未定制），env 默认兜底。 */
export async function resolveMonthlyQuota(orgId: string): Promise<number> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { monthlyAnswerQuota: true },
  });
  return org?.monthlyAnswerQuota ?? defaultQuota();
}

/**
 * 已用量 = 本月该组织的 user 消息数。**每次现算，不存累计字段。**
 *
 * 为什么不存计数器（这个决定值得记下来，防止将来被"优化"回去）：
 *   计数器是"读-改-写"维护的状态，任何维护累计值的系统都要回答
 *   失败算不算、中断算不算、迁移/修数之后对不对 —— 答案是迟早对不上，
 *   然后你需要一个"重算"脚本，而重算的依据就是这里的事实本身。
 *   现算方案等于永远在对账，代价只是每次提问多一次聚合查询（数据量小时几毫秒）。
 */
export async function countMonthlyQuestions(
  orgId: string,
  tx: Pick<typeof prisma, 'message'> = prisma,
): Promise<number> {
  return tx.message.count({
    where: {
      role: 'user',
      conversation: { orgId },
      createdAt: { gte: monthStart() },
    },
  });
}

/** settings 页的用量显示：一次查询拿齐。 */
export async function getMonthlyUsage(orgId: string): Promise<{ used: number; limit: number }> {
  const [used, limit] = await Promise.all([
    countMonthlyQuestions(orgId),
    resolveMonthlyQuota(orgId),
  ]);
  return { used, limit };
}

/**
 * 原子占用一个问答名额：配额检查 + user 消息落库在**同一个事务**里。
 *
 * 为什么事务里先锁组织行（FOR UPDATE）：
 *   "先查还剩多少，没超就插"在并发下不是原子的 —— 两个成员在同一毫秒问到最后一题，
 *   两个请求都读到 used = limit - 1，都插，超发一个。单机自测撞不上，线上只是时间问题。
 *   锁住组织行后，同一组织的配额判断串行执行，第二个请求一定看到第一个的结果。
 *   锁的粒度 = 配额的语义粒度（组织），跨组织完全不受影响；同组织串行的代价是几毫秒。
 *
 * 为什么不把"回答生成完"再计：口径是**提问即计**（拍板记录见 spec）——
 *   已用量恒等于本月 user 消息数，永远可对账；每个请求必占名额，天然防刷；
 *   不需要定义"什么算成功"（complete？stopped 算吗？——定义本身就是漏洞）。
 *
 * 超限抛 QuotaExceeded → 事务自动回滚 → user 消息不落库（C4：不产生半截会话）。
 */
export async function consumeMonthlyQuestion(params: {
  orgId: string;
  conversationId: string;
  content: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // 锁组织行直到事务提交。$queryRaw 带参数占位符，不拼字符串。
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${params.orgId} FOR UPDATE`;

    const [used, org] = await Promise.all([
      countMonthlyQuestions(params.orgId, tx),
      tx.organization.findUnique({
        where: { id: params.orgId },
        select: { monthlyAnswerQuota: true },
      }),
    ]);

    const limit = org?.monthlyAnswerQuota ?? defaultQuota();
    if (used >= limit) {
      throw new QuotaExceeded(used, limit);
    }

    await tx.message.create({
      data: { conversationId: params.conversationId, role: 'user', content: params.content },
      select: { id: true },
    });
  });
}
