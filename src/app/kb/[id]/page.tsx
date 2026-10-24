import Link from 'next/link';
import { notFound } from 'next/navigation';

import { prisma } from '@/lib/prisma';
import { requireUserId } from '@/lib/session';

import { ChatPanel } from './ChatPanel';
import { DeleteDocumentButton } from './DeleteDocumentButton';
import { ReindexButton } from './ReindexButton';
import { UploadForm } from './UploadForm';

/**
 * 注意：Next 15/16 里 page 的 params 是 **Promise**，必须 await。
 * 直接解构会拿到一个 Promise 对象而不是 { id } —— 查库就查了个寂寞。
 */
export default async function KnowledgeBaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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

  return (
    <main className="flex min-h-screen flex-col gap-6 p-8">
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
      */}
      <ChatPanel kbId={kb.id} disabled={readyCount === 0} />
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
