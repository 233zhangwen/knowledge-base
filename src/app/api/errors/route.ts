/**
 * 客户端错误上报入口：`POST /api/errors`
 *
 * 谁在调：`src/app/error.tsx`（渲染错误，带 React 的 digest）。
 * 为什么不直接在 error.tsx 里连 DB：那是 client component，连不了库，也绝不能
 * 把写库权限暴露到浏览器。
 *
 * 安全边界（这是个公开可打的接口，按公开接口对待）：
 *   · 未登录一律不写（返回 204 静默丢弃，不给探测者任何反馈）；
 *   · 字段长度硬截断，message 最多 2000 / stack 最多 8000；
 *   · 不信任客户端传的 level，服务端固定记 error；
 *   · 真正的写库频控在 reportError 的进程内节流里，这里不重复实现。
 */
import { auth } from '@/auth';
import { reportError } from '@/lib/error-report';

export const dynamic = 'force-dynamic';

function clamp(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return value.slice(0, max);
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    // 静默：未登录不上报。返回 204 而不是 401 —— 401 会让浏览器控制台多一条
    // 与真正问题无关的红字，把排查方向带偏。
    return new Response(null, { status: 204 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  const body = (payload ?? {}) as Record<string, unknown>;
  const event = clamp(body.event, 100) ?? 'client.error';
  const message = clamp(body.message, 2000) ?? 'unknown';

  void reportError({
    event,
    message,
    stack: clamp(body.stack, 8000),
    path: clamp(body.path, 300),
    digest: clamp(body.digest, 100),
  });

  return Response.json({ ok: true });
}
