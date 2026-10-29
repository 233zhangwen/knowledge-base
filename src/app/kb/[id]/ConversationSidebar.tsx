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
 * 视觉演进史：
 *   横向 chip（截断/无滑动暗示/选中态弱）→ details 折叠 → 浮层抽屉（2026-10-27）
 *   → 边框卡片（每条一个 border，视觉噪音大、红色"删除"悬浮在外）
 *   → 2026-10-29 A+C 混合：无边框列表 + 时间分组头（今天/昨天/…），
 *     删除改垃圾桶图标悬停浮现，红色只在确认那一步出现。
 */
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

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
  /**
   * 窄屏浮层（2026-10-27 方案 C）的开合态。
   * 只在窄屏渲染的那半边用到；lg 竖列是纯静态标记，不吃这个状态。
   */
  const [panelOpen, setPanelOpen] = useState(false);
  /** 点外部关闭：需要拿到"浮层 + 按钮"这整块区域的 DOM 引用 */
  const panelRootRef = useRef<HTMLDivElement>(null);

  /**
   * 点外部关闭 + Esc 关闭。
   * 用 pointerdown 而不是 click：按下那一刻就判定，避免"点别的按钮先触发
   * 关闭又触发那个按钮的行为"这类时序坑。open 时才挂监听，省空转。
   */
  useEffect(() => {
    if (!panelOpen) return;

    function onPointerDown(e: PointerEvent) {
      if (panelRootRef.current && !panelRootRef.current.contains(e.target as Node)) {
        setPanelOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setPanelOpen(false);
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [panelOpen]);

  return (
    /**
     * 响应式：窄屏 → "历史会话（N）"按钮点开悬浮面板；lg 起 → 224px 竖列常开。
     * 两个形态共用 ConversationGroups 的分组渲染，改一处两边同步。
     */
    <aside className="flex w-full shrink-0 flex-col gap-2 lg:w-56">
      <div className="flex flex-row items-start gap-2 lg:flex-col">
        {/* 必须是按钮不是 Link：见 NewConversationButton.tsx 顶部的 bug 复盘 */}
        <NewConversationButton kbId={kbId} active={activeId === null} />

        {conversations.length === 0 ? (
          <p className="px-1 py-2 text-xs text-zinc-400">还没有会话。问一句就有了。</p>
        ) : (
          <>
            {/* 窄屏：按钮 + 悬浮面板。relative 挂在这一小块上，面板以它为锚 */}
            <div ref={panelRootRef} className="relative min-w-0 flex-1 lg:hidden">
              <button
                type="button"
                onClick={() => setPanelOpen((v) => !v)}
                aria-expanded={panelOpen}
                className={`whitespace-nowrap rounded-lg border px-3 py-2 text-sm ${
                  panelOpen ? 'border-zinc-400 bg-zinc-100' : 'hover:bg-zinc-50'
                }`}
              >
                历史会话（{conversations.length}）
              </button>

              {panelOpen ? (
                <div className="absolute left-0 top-full z-20 mt-1 max-h-[288px] w-[280px] max-w-[calc(100vw-3rem)] overflow-y-auto rounded-lg border border-zinc-200 bg-white p-1">
                  <ConversationGroups
                    kbId={kbId}
                    conversations={conversations}
                    activeId={activeId}
                    onNavigate={() => setPanelOpen(false)}
                  />
                </div>
              ) : null}
            </div>

            {/* lg 及以上：竖列常开，和浮层是同一套条目渲染 */}
            <ConversationGroups kbId={kbId} conversations={conversations} activeId={activeId} />
          </>
        )}
      </div>
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
  onNavigate,
}: {
  kbId: string;
  conversations: SidebarItem[];
  activeId: string | null;
  onNavigate?: () => void;
}) {
  const groups = new Map<string, SidebarItem[]>();
  for (const c of conversations) {
    const bucket = groups.get(c.group);
    if (bucket) bucket.push(c);
    else groups.set(c.group, [c]);
  }

  /* 滚动不在这里：浮层整体（max-h）或 lg 竖列（不限制）负责，内层列表只管排版 */
  const listClass = 'm-0 flex list-none flex-col gap-0.5 p-0';

  return (
    <ul className="m-0 list-none p-0">
      {[...groups.entries()].map(([label, items], gi) => (
        <li key={label}>
          {/* 分组头：第一个组不额外留上边距（面板/竖列的顶部本来就贴着按钮） */}
          <p className={`px-2 pb-1 text-[11px] text-zinc-400 ${gi === 0 ? 'pt-1' : 'pt-3'}`}>
            {label}
          </p>
          <ul className={listClass}>
            {items.map((c) => (
              <ConversationLink
                key={c.id}
                kbId={kbId}
                item={c}
                active={c.id === activeId}
                onNavigate={onNavigate}
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
 *
 * onNavigate：浮层里点完一条要收起面板 —— Link 导航是 RSC 重渲染，
 * 组件实例不会卸载，useState 会活着，不主动关面板就会一直开着挡视线。
 */
function ConversationLink({
  kbId,
  item,
  active,
  onNavigate,
}: {
  kbId: string;
  item: SidebarItem;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <li className="group/row relative w-full">
      <Link
        href={`/kb/${kbId}?c=${item.id}`}
        onClick={onNavigate}
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

      {/* 删除入口：浮层和 lg 竖列都有；两步确认在按钮组件内部 */}
      <DeleteConversationButton id={item.id} kbId={kbId} active={active} />
    </li>
  );
}
