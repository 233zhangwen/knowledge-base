import Link from 'next/link';
import { notFound } from 'next/navigation';

import type { Citation } from '@/lib/chat-protocol';
import { conversationTimeParts } from '@/lib/conversation-time';
import { ConversationNotFound, loadConversationMessages, listConversations } from '@/lib/history';
import { prisma } from '@/lib/prisma';
import { requireUserId } from '@/lib/session';

import { ChatPanel, type UiMessage } from './ChatPanel';
import { ConversationSidebar, type SidebarItem } from './ConversationSidebar';
import { DeleteDocumentButton } from './DeleteDocumentButton';
import { ReindexButton } from './ReindexButton';
import { UploadForm } from './UploadForm';

/**
 * 注意：Next 15/16 里 page 的 params 和 searchParams 都是 **Promise**，必须 await。
 * 直接解构会拿到一个 Promise 对象而不是 { id } —— 查库就查了个寂寞。
 *
 * searchParams.c 是"当前打开的会话 id"：把它放进 URL 而不是本地 state，
 * 刷新、前进后退、重新打开链接才全都正确（spec A1 靠的就是它）。
 */
export default async function KnowledgeBaseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ c?: string; n?: string }>;
}) {
  const { id } = await params;
  const { c, n } = await searchParams;
  const userId = await requireUserId();

  const kb = await prisma.knowledgeBase.findFirst({
    // 归属校验放在查询条件里，而不是"先查出来再判断是不是我的"
    where: { id, userId },
    select: {
      id: true,
      name: true,
      description: true,
      documents: {
        orderBy: { createdAt: 'desc' },
        /**
         * ⚠️ 刻意不 select content。
         * Server Component 里查出来的每个字段都会被序列化进 RSC payload 发给浏览器，
         * 而 content 可能是几十万字 —— 列表页根本用不到它，带上就是纯浪费带宽。
         * "只查你要显示的字段"在 RSC 里是性能优化，不是洁癖。
         */
        select: {
          id: true,
          title: true,
          sourceType: true,
          sizeBytes: true,
          status: true,
          error: true,
          createdAt: true,
          _count: { select: { chunks: true } },
        },
      },
    },
  });

  if (!kb) {
    notFound();
  }

  const readyCount = kb.documents.filter((d) => d.status === 'ready').length;

  /**
   * 会话侧栏：只列最近 20 个（决策③：会话分组代替分页，spec A6）。
   * 会话本身就是天然的数据边界 —— 一次会话很少超过 30 条消息，
   * 用它做分组就已经解决了"数据量无限增长"，不需要再套一层滚动分页。
   */
  const conversations = await listConversations(userId, kb.id);
  const now = new Date();
  const sidebarItems: SidebarItem[] = conversations.map((c) => {
    const { timeText, group } = conversationTimeParts(c.updatedAt, now);
    return {
      id: c.id,
      title: c.title,
      messageCount: c._count.messages,
      timeText,
      group,
    };
  });

  /**
   * 选中的会话：从 URL 的 ?c= 来。
   *
   * 即便它不在上面那 20 个里也照样能打开 —— 侧栏只是导航，
   * 不能反过来限制"哪些会话可访问"。这也是为什么这里要重新查一次而不是从列表里找。
   * `loadConversationMessages` 内部已经用 userId 过滤过（spec C1），这里再对一次 kbId（spec C2）。
   */
  let activeConversationId: string | null = null;
  let initialMessages: UiMessage[] = [];
  if (c) {
    try {
      const { conversation, messages } = await loadConversationMessages(userId, c);
      if (conversation.kbId === kb.id) {
        activeConversationId = conversation.id;
        initialMessages = messages.map((m) => ({
          id: m.id,
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
          /**
           * 数据库里存的是 Json，这里断言成 Citation[]。
           * 落库时就确保了形状 —— 它是那份快照本身（spec A3），不是查出来的当前 chunk。
           */
          citations: (m.citations as unknown as Citation[] | null) ?? null,
          finishReason: m.finishReason === 'stopped' ? 'stopped' : 'complete',
        }));
      }
    } catch (error) {
      if (!(error instanceof ConversationNotFound)) throw error;
      // 别人的会话 / 不存在的会话：当成没选中即可，不报错也不泄露
    }
  }

  return (
    /**
     * p-4 sm:p-8：手机上 32px 的页边距会吃掉三分之一的可用宽度 ——
     * 聊天区"挤"的一半原因在这。max-w-5xl：超宽屏上文本行太长不好读，
     * 收住上限居中。
     */
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 p-4 sm:p-8">
      <header className="flex flex-col gap-2 border-b pb-4">
        <Link href="/kb" className="text-sm text-zinc-500 hover:text-zinc-900">
          ← 返回知识库列表
        </Link>
        <h1 className="text-xl font-semibold">{kb.name}</h1>
        {kb.description ? (
          <p className="text-sm text-zinc-500">{kb.description}</p>
        ) : null}
        <p className="text-xs text-zinc-400">
          共 {kb.documents.length} 个文档，其中 {readyCount} 个已就绪
        </p>
      </header>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-zinc-500">上传</h2>
        <UploadForm kbId={kb.id} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-zinc-500">文档</h2>

        {kb.documents.length === 0 ? (
          <p className="rounded-lg border border-dashed p-8 text-center text-sm text-zinc-400">
            还没有文档。上传一个 Markdown 或 TXT 文件试试。
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {kb.documents.map((doc) => (
              <li
                key={doc.id}
                className="flex items-center justify-between gap-4 rounded-lg border p-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {/* min-w-0 + truncate：长文件名不至于把按钮挤出去 */}
                    <span className="truncate font-medium">{doc.title}</span>
                    <StatusChip status={doc.status} />
                  </div>
                  <p className="mt-1 text-xs text-zinc-400">
                    {doc.sourceType.toUpperCase()}
                    {doc.sizeBytes !== null ? ` · ${formatBytes(doc.sizeBytes)}` : ''}
                    {` · ${doc._count.chunks} 个切片`}
                    {` · ${DATE_FORMATTER.format(doc.createdAt)}`}
                  </p>
                  {doc.error ? (
                    <p className="mt-1 text-xs text-red-600">失败原因：{doc.error}</p>
                  ) : null}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <ReindexButton id={doc.id} />
                  <DeleteDocumentButton id={doc.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/*
        问答放在最后：它是这个页面唯一"用得上前面所有成果"的功能。
        readyCount === 0 时整个面板禁用 —— 与其让用户问一句拿到
        "文档中没有相关内容"，不如直接说明为什么问不了。

        key={activeConversationId}：切换会话时靠卸载重挂载清空本地状态
        （useState 没有 reset API；这一步顺带保证了 E2「新旧会话互不干扰」）。
        #n：一次性 nonce（NewConversationButton 点击时生成）。没有它，
        在"新对话"里问过一句后再点「新对话」，key 两次都是 'new'，
        面板不重挂载，上一段对话就残留了（2026-10-27 实测 bug）。

        响应式：窄屏侧栏没有资格占一列 —— 224px 固定宽度在手机上
        会把聊天区压到一两百像素（实测截图），改成上下堆叠后
        侧栏自己变成横向滚动的一行；lg 及以上才恢复左右布局。
      */}
      <section className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-6">
        <ConversationSidebar
          kbId={kb.id}
          conversations={sidebarItems}
          activeId={activeConversationId}
        />
        <ChatPanel
          key={`${activeConversationId ?? 'new'}#${n ?? ''}`}
          kbId={kb.id}
          conversationId={activeConversationId}
          initialMessages={initialMessages}
          disabled={readyCount === 0}
        />
      </section>
    </main>
  );
}

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700',
  processing: 'bg-amber-100 text-amber-700',
  ready: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
};

const STATUS_LABEL: Record<string, string> = {
  pending: '处理中',
  /**
   * W3 之后 processing 的含义变了：不再是"解析中"，而是"解析已完成、正在切片和向量化"。
   * 状态名字没变但语义变了 —— 这种地方不改文案，用户（和三个月后的自己）就会误判进度。
   */
  processing: '生成索引中',
  ready: '已就绪',
  failed: '失败',
};

function StatusChip({ status }: { status: string }) {
  return (
    <span
      data-testid="doc-status"
      data-status={status}
      className={`shrink-0 rounded px-2 py-0.5 text-xs ${
        STATUS_STYLE[status] ?? 'bg-zinc-100 text-zinc-600'
      }`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

/**
 * 日期在服务端格式化好再传下来 —— 客户端和服务器时区不一致会触发 hydration 警告。
 * 服务端渲染一次、客户端 hydration 时不重算，两边字符串自然相同。
 */
const DATE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/**
 * 会话侧栏的相对时间 + 分组标签（2026-10-29 A+C 改版）。
 * W12 起逻辑搬到 src/lib/conversation-time.ts —— 抽出去是为了能单测
 * （4 个分支，改坏了不报错、只写错分组头）。调用方式不变。
 */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
