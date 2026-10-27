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
 */
import Link from 'next/link';

export type SidebarItem = {
  id: string;
  title: string | null;
  messageCount: number;
  /** 服务端格式化好的时间字符串：避免客户端服务器时区不一致引起 hydration 警告 */
  updatedAtText: string;
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
    /**
     * 响应式（2026-10-27 改版）：
     *   窄屏  → 横向滚动的一行（会话变成 chip，不占纵向空间）；
     *   lg 起 → 恢复 224px 的竖列。
     * 之前固定 w-56 的竖列在手机上会把聊天区压到一两百像素 ——
     * 布局挤的直接根因。overflow-x-auto 让"会话多"在窄屏下表现为横向滑，
     * 而不是把页面撑长。
     */
    <aside className="flex w-full shrink-0 flex-row items-start gap-2 overflow-x-auto pb-1 lg:w-56 lg:flex-col lg:overflow-visible lg:pb-0">
      <Link
        href={`/kb/${kbId}`}
        className={`shrink-0 whitespace-nowrap rounded-lg border px-3 py-2 text-center text-sm ${
          activeId === null
            ? 'border-zinc-900 bg-zinc-900 text-white'
            : 'hover:bg-zinc-50'
        }`}
      >
        ＋ 新对话
      </Link>

      {conversations.length === 0 ? (
        <p className="shrink-0 px-1 py-2 text-xs text-zinc-400">还没有会话。问一句就有了。</p>
      ) : (
        <ul className="flex flex-row gap-1 lg:flex-col">
          {conversations.map((c) => (
            <li key={c.id} className="shrink-0 lg:w-full">
              <Link
                href={`/kb/${kbId}?c=${c.id}`}
                className={`block max-w-[240px] rounded-lg border px-3 py-2 text-xs ${
                  c.id === activeId
                    ? 'border-zinc-400 bg-zinc-100'
                    : 'hover:bg-zinc-50'
                }`}
              >
                {/* title 理论上不会为空（建会话时就写了），但仍要兜住 —— 直接渲染 null 会白屏一格 */}
                <p className="truncate font-medium">{c.title ?? '未命名会话'}</p>
                <p className="mt-0.5 whitespace-nowrap text-zinc-400">
                  {c.messageCount} 条 · {c.updatedAtText}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
