import Link from 'next/link';

import { prisma } from '@/lib/prisma';
import { requireTenant } from '@/lib/session';

import { switchOrg } from '../settings/actions';

/**
 * 顶栏组织切换器（W20）。
 *
 * 用 <details>/<summary> 做下拉、每个选项一个 form 按钮：不需要任何客户端 JS。
 * 切换本身是 server action（switchOrg 写 cookie + revalidate），选中后服务端
 * 组件重渲染，页面上出现的就是新组织的数据 —— 没有前端过滤，也就没有
 * "前端切了显示、后端还在旧组织"这种两层状态不一致的坑。
 *
 * 单组织时不显示下拉：只显示组织名和设置入口，不给一个只有一个选项的下拉框。
 */
export async function OrgSwitcher() {
  const { userId, orgId } = await requireTenant();

  const memberships = await prisma.membership.findMany({
    where: { userId },
    include: { org: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const current = memberships.find((m) => m.orgId === orgId) ?? memberships[0];
  if (!current) return null;

  if (memberships.length <= 1) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className="text-zinc-600">{current.org.name}</span>
        <Link href="/settings" className="text-zinc-500 hover:text-zinc-800">
          设置
        </Link>
      </div>
    );
  }

  return (
    <details className="relative">
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100">
        <span className="max-w-40 truncate">{current.org.name}</span>
        <span className="text-xs text-zinc-400">▼</span>
      </summary>
      <div className="absolute right-0 z-10 mt-1 w-56 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg">
        {memberships.map((m) => (
          <form action={switchOrg} key={m.id}>
            <input type="hidden" name="orgId" value={m.orgId} />
            <button
              type="submit"
              className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm hover:bg-zinc-100 ${
                m.orgId === orgId ? 'font-medium text-emerald-700' : 'text-zinc-700'
              }`}
            >
              <span className="max-w-40 truncate">{m.org.name}</span>
              {m.orgId === orgId ? <span className="text-xs">当前</span> : null}
            </button>
          </form>
        ))}
        <Link
          href="/settings"
          className="block border-t border-zinc-100 px-4 py-2 text-sm text-zinc-500 hover:bg-zinc-100"
        >
          组织设置 / 邀请成员
        </Link>
      </div>
    </details>
  );
}
