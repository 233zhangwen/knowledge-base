'use client';

/**
 * 会话侧栏：列出该知识库下最近的会话（决策③：会话分组代替分页）。
 *
 * 为什么用 Link 跳转而不是本地 state：
 *   会话的 URL 是 `/kb/[id]?c=<conversationId>` —— 把"当前看的是哪个会话"
 *   放进 URL，刷新、前进后退、分享链接全都自动正确。
 *   用 state 存的话，一刷新就回到"没选会话"，而 spec A1（刷新不丢）正是靠 URL 撑住的。
 *
 * 为什么交给 Server Component 重渲染而不是前端再拉一次消息：
 *   页面本来就要查会话列表，顺带把选中会话的消息一起查出来，一次往返拿完。
 *   前端再 fetch 一次消息 = 多一个请求、多一段 loading 状态，什么也没换到。
 *
 * 视觉/交互演进史：
 *   横向 chip（截断/无滑动暗示/选中态弱）→ details 折叠（推聊天区）→
 *   浮层抽屉（2026-10-27，不推挤但多一次点击）→ 边框卡片 →
 *   2026-10-29 A+C 混合 + 去浮层：无边框分组列表直接常显（窄屏限高滚动），
 *   点开即见，不再为"省那点空间"多一次交互 —— 用户实测浮层没必要。
 */
import Link from 'next/link';

import { DeleteConversationButton } from './DeleteConversationButton';
import { NewConversationButton } from './NewConversationButton';

export type SidebarItem = {
  id: string;
  title: string | null;
  messageCount: number;
  /** 相对时间（今天/昨天/M 月 D 日/…），服务端算好 —— 避免 hydration 时钟差 */
  timeText: string;
  /** 分组头标签，与 timeText 同源（同一天必同标签），服务端排序后相邻必同组 */
  group: string;
};

export function ConversationSidebar({
  kbId,
  conversations,
  activeId,
}: {
  kbId: string;
  conversations: SidebarItem[];
  activeId: string | null;
}) {
  return (
    <aside className="flex w-full shrink-0 flex-col gap-2 lg:w-56">
      <NewConversationButton kbId={kbId} active={activeId === null} />

      {conversations.length === 0 ? (
        <p className="px-1 py-2 text-xs text-zinc-400">还没有会话。问一句就有了。</p>
      ) : (
        <>
          {/* 窄屏：列表直接常显，限高滚动（避免长列表把聊天区推没）；lg 隐藏 */}
          <div className="max-h-[288px] overflow-y-auto lg:hidden">
            <ConversationGroups kbId={kbId} conversations={conversations} activeId={activeId} />
          </div>

          {/* lg 及以上：竖列常开，和窄屏是同一套条目渲染 */}
          <div className="hidden lg:block">
            <ConversationGroups kbId={kbId} conversations={conversations} activeId={activeId} />
          </div>
        </>
      )}
    </aside>
  );
}

/**
 * 按天分组的会话列表（A+C 混合的时间分组部分）。
 *
 * 服务端已按 updatedAt 倒序返回 → 同一天必然相邻，按 group 标签顺序合并即可。
 * 用 Map 而不是"和上一条比较"：万一将来排序键变化，Map 按插入序也能正确归组。
 */
function ConversationGroups({
  kbId,
  conversations,
  activeId,
}: {
  kbId: string;
  conversations: SidebarItem[];
  activeId: string | null;
}) {
  const groups = new Map<string, SidebarItem[]>();
  for (const c of conversations) {
    const bucket = groups.get(c.group);
    if (bucket) bucket.push(c);
    else groups.set(c.group, [c]);
  }

  return (
    <ul className="m-0 list-none p-0">
      {[...groups.entries()].map(([label, items], gi) => (
        <li key={label}>
          {/* 分组头：第一个组不额外留上边距（列表顶部本来就贴着按钮） */}
          <p className={`px-2 pb-1 text-[11px] text-zinc-400 ${gi === 0 ? 'pt-1' : 'pt-3'}`}>
            {label}
          </p>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {items.map((c) => (
              <ConversationLink
                key={c.id}
                kbId={kbId}
                item={c}
                active={c.id === activeId}
              />
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/**
 * 单条会话 = 「打开」+「删除」两个动作。
 *
 * 2026-10-29 去边框改版：
 *   · 选中 = 灰底（bg-zinc-100），悬停 = 浅灰（hover:bg-zinc-50），不再靠边框；
 *   · 删除按钮绝对定位在行右侧，桌面悬停才浮现（group-hover/row），
 *     触屏没有 hover → pointer:coarse 媒体查询常显；
 *     两步确认（灰图标 → 红色"确认/取消"）仍在按钮组件内部。
 *   · Link 右侧留 pr-7：图标浮现时压不着标题。
 */
function ConversationLink({
  kbId,
  item,
  active,
}: {
  kbId: string;
  item: SidebarItem;
  active: boolean;
}) {
  return (
    <li className="group/row relative w-full">
      <Link
        href={`/kb/${kbId}?c=${item.id}`}
        className={`block min-w-0 flex-1 rounded-lg py-1.5 pl-2.5 pr-7 text-xs ${
          active ? 'bg-zinc-100' : 'hover:bg-zinc-50'
        }`}
      >
        {/* title 理论上不会为空（建会话时就写了），但仍要兜住 —— 直接渲染 null 会白屏一格 */}
        <p className="truncate font-medium">{item.title ?? '未命名会话'}</p>
        <p className="mt-0.5 whitespace-nowrap text-zinc-400">
          {item.messageCount} 条 · {item.timeText}
        </p>
      </Link>

      {/* 删除入口；两步确认在按钮组件内部 */}
      <DeleteConversationButton id={item.id} kbId={kbId} active={active} />
    </li>
  );
}
