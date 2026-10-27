/**
 * 健康检查端点：`GET /api/health`
 *
 * 为什么要有它：部署平台（Netlify / Vercel）的"部署成功"只说明构建过了，
 * 不说明**运行时**能不能连上数据库、能不能读到环境变量。上线后第一件事、
 * 以及以后每次改环境变量后，都应该打一下这个端点，而不是靠"点开网页看看"。
 *
 * 设计取舍：
 *   - 只报告**布尔与版本号**，不返回任何连接串、密钥、错误堆栈细节 ——
 *     这个地址是公开的，任何泄漏都会被搜索引擎抓走。
 *   - DB 不通返回 503（而不是 200 + ok:false），因为健康检查的消费方
 *     （人、监控、将来的 uptime 探针）都按状态码判断，语义要直白。
 *   - 强制 no-store：健康检查被 CDN 缓存住就等于没有。
 */
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET() {
  const startedAt = Date.now();
  let db: 'up' | 'down' = 'down';
  let dbLatencyMs: number | null = null;
  let dbVersion: string | null = null;

  try {
    const rows = await prisma.$queryRaw<{ version: string }[]>`select version() as version`;
    db = 'up';
    dbLatencyMs = Date.now() - startedAt;
    // 只取主版本号段（"PostgreSQL 18.6 ..."），不带完整的编译信息
    dbVersion = String(rows[0]?.version ?? '').split(' ').slice(0, 2).join(' ') || null;
  } catch (error) {
    // 日志留在服务端（平台日志里能看），响应体里只给状态
    console.error('[health] 数据库探测失败', error);
  }

  const body = {
    status: db === 'up' ? 'ok' : 'degraded',
    db,
    dbVersion,
    dbLatencyMs,
    // 构建时注入的 commit（见 next.config.ts），用来确认"线上跑的是哪一版"
    commit: process.env.NEXT_PUBLIC_COMMIT_REF ?? 'unknown',
    time: new Date().toISOString(),
  };

  return Response.json(body, {
    status: db === 'up' ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}
