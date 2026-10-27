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

import { NewConversationButton } from './NewConversationButton';

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
     * 响应式（2026-10-27 二次改版，方案 A：折叠列表）：
     *   窄屏  → "历史会话（N）"折叠起来，点开是全宽竖列；
     *   lg 起 → 维持 224px 竖列常开。
     *
     * 为什么放弃横向滚动 chip（上一版）：
     *   ① 标题是用户的提问，天然是长句，chip 里永远要截断；
     *   ② 第二行"N 条 · 日期"在窄 chip 里被硬截成"N 条 · 20"；
     *   ③ 右缘生硬切断，看不出后面还有会话、可以滑；
     *   ④ 选中项浅灰底和新对话按钮挤一行，一眼认不出"正在看哪个"。
     * 折叠列表把这三件事一次解决：标题完整可见、不存在截断、
     * 展开后的列表和 lg 竖列复用同一套渲染。
     *
     * 为什么用原生 <details> 而不是 useState + 条件渲染：
     *   开合是纯展示态，不参与任何数据流 —— 用平台自带的能力，
     *   零 JS、零状态管理、键盘和读屏支持白送。这也意味着它必须是
     *   Client Component 之外的普通标记（本文件整体是 server component，
     *   details 是 HTML 原生行为，不需要 'use client'）。
     */
    <aside className="flex w-full shrink-0 flex-col gap-2 lg:w-56">
      <div className="flex flex-row items-start gap-2 lg:flex-col">
        {/* 必须是按钮不是 Link：见 NewConversationButton.tsx 顶部的 bug 复盘 */}
        <NewConversationButton kbId={kbId} active={activeId === null} />

        {conversations.length === 0 ? (
          <p className="px-1 py-2 text-xs text-zinc-400">还没有会话。问一句就有了。</p>
        ) : (
          <>
            {/* 窄屏：折叠列表。flex-1 让展开的列表吃掉按钮右侧的全部剩余宽度 */}
            <details className="min-w-0 flex-1 lg:hidden">
              <summary className="inline-flex cursor-pointer select-none items-center whitespace-nowrap rounded-lg border px-3 py-2 text-sm hover:bg-zinc-50">
                历史会话（{conversations.length}）
              </summary>
              <ul className="mt-2 flex flex-col gap-1 rounded-lg border border-zinc-200 p-1">
                {conversations.map((c) => (
                  <ConversationLink key={c.id} kbId={kbId} item={c} active={c.id === activeId} />
                ))}
              </ul>
            </details>

            {/* lg 及以上：竖列常开，和折叠列表是同一套条目渲染 */}
            <ul className="hidden flex-col gap-1 lg:flex">
              {conversations.map((c) => (
                <ConversationLink key={c.id} kbId={kbId} item={c} active={c.id === activeId} />
              ))}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * 单条会话。窄屏折叠列表和 lg 竖列共用 —— 两份拷贝迟早改不同步。
 * 之前 chip 版的 max-w-[240px] 删掉了：竖列里条目就是全宽，截断交给 truncate。
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
    <li className="w-full">
      <Link
        href={`/kb/${kbId}?c=${item.id}`}
        className={`block rounded-lg border px-3 py-2 text-xs ${
          active ? 'border-zinc-400 bg-zinc-100' : 'hover:bg-zinc-50'
        }`}
      >
        {/* title 理论上不会为空（建会话时就写了），但仍要兜住 —— 直接渲染 null 会白屏一格 */}
        <p className="truncate font-medium">{item.title ?? '未命名会话'}</p>
        <p className="mt-0.5 whitespace-nowrap text-zinc-400">
          {item.messageCount} 条 · {item.updatedAtText}
        </p>
      </Link>
    </li>
  );
}
