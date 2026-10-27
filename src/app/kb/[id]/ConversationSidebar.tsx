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
import { useEffect, useRef, useState } from 'react';

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
     * 响应式（2026-10-27 三次改版，方案 C：浮层抽屉）：
     *   窄屏  → "历史会话（N）"按钮点开一个悬浮面板，盖在聊天区上方；
     *   lg 起 → 维持 224px 竖列常开。
     *
     * 演进史：横向滚动 chip（截断/无滑动暗示/选中态弱）→ details 折叠列表
     * （零 JS，但展开会把聊天区整个往下推）→ 浮层（不推挤内容）。
     * 浮层的代价是要自己管开合、点外部关闭和 Esc —— 见上面的 effect，
     * 这是在为"不推挤内容"付的三笔账，没有白来的浮层。
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
                <div className="absolute left-0 top-full z-20 mt-1 w-[280px] max-w-[calc(100vw-3rem)] rounded-lg border border-zinc-200 bg-white p-1">
                  <ul className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto">
                    {conversations.map((c) => (
                      <ConversationLink
                        key={c.id}
                        kbId={kbId}
                        item={c}
                        active={c.id === activeId}
                        onNavigate={() => setPanelOpen(false)}
                      />
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            {/* lg 及以上：竖列常开，和浮层是同一套条目渲染 */}
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
 * 单条会话。窄屏浮层和 lg 竖列共用 —— 两份拷贝迟早改不同步。
 * 之前 chip 版的 max-w-[240px] 删掉了：竖列里条目就是全宽，截断交给 truncate。
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
    <li className="w-full">
      <Link
        href={`/kb/${kbId}?c=${item.id}`}
        onClick={onNavigate}
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
