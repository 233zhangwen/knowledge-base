'use client';

/**
 * 「新对话」为什么是客户端按钮而不是 Link —— 这是 2026-10-27 那个 bug 的核心。
 *
 * bug 复盘：
 *   在"新对话"面板里问了一句后，会话在服务端诞生了，但 URL 还是 /kb/[id]（没带 ?c=）。
 *   此时点「新对话」，Link 的目标 URL 和当前 URL 完全相同 → Next 不重新渲染，
 *   ChatPanel 的 key 也没变（两次都是 'new'）→ 不重挂载 → 上一段对话残留在面板里。
 *   （先点过历史会话再点新对话不复现 —— 因为 key 变了。）
 *
 * 根本矛盾：page.tsx 只能根据 URL 算 key，而"客户端刚创建的会话"服务端并不知道。
 * 解法：点击时往 URL 塞一个一次性 nonce（?n=时间戳），page 把它并进 key ——
 *   nonce 每次点击都不同 → key 必变 → 重挂载必然发生，不再依赖"URL 恰好不同"。
 *
 * scroll: false —— 面板在页面底部，导航默认滚回顶部会把用户正在看的聊天区弹出视野。
 */
import { useRouter } from 'next/navigation';

export function NewConversationButton({
  kbId,
  active,
}: {
  kbId: string;
  active: boolean;
}) {
  const router = useRouter();

  return (
    <button
      type="button"
      data-testid="new-conversation"
      onClick={() => router.push(`/kb/${kbId}?n=${Date.now()}`, { scroll: false })}
      className={`shrink-0 whitespace-nowrap rounded-lg border px-3 py-2 text-center text-sm ${
        active ? 'border-zinc-900 bg-zinc-900 text-white' : 'hover:bg-zinc-50'
      }`}
    >
      ＋ 新对话
    </button>
  );
}
