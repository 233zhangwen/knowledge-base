'use server';

import { revalidatePath } from 'next/cache';

import { buildStorageKey, contentTypeFor, detectSourceType, MAX_FILE_SIZE } from '@/lib/file-types';
import { indexDocument } from '@/lib/index-document';
import { extractText } from '@/lib/parse';
import { prisma } from '@/lib/prisma';
import { requireUserId } from '@/lib/session';
import { removeQuietly, storage } from '@/lib/storage';

import type { ActionState } from '@/lib/action-state';

export type { ActionState };

/** 把异常里的信息取出来给用户看。内部错误堆栈不该漏到 UI 上，所以只取 message。 */
function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function uploadDocument(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const userId = await requireUserId();

  const kbId = String(formData.get('kbId') ?? '');
  if (!kbId) {
    return { error: '缺少知识库 id' };
  }

  /**
   * kbId 来自表单，所以**必须**先验归属。
   * 这是铁律的延伸：凡是从客户端来的 id，都要和 session 里的 userId 做一次 AND，
   * 不能直接拿去查。这里用的是 findFirst({ where: { id, userId } })。
   */
  const kb = await prisma.knowledgeBase.findFirst({
    where: { id: kbId, userId },
    select: { id: true },
  });
  if (!kb) {
    return { error: '知识库不存在或无权访问' };
  }

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { error: '请选择要上传的文件' };
  }
  if (file.size > MAX_FILE_SIZE) {
    return {
      error: `文件不能超过 ${MAX_FILE_SIZE / 1024 / 1024}MB（当前 ${(file.size / 1024 / 1024).toFixed(1)}MB）`,
    };
  }

  const sourceType = detectSourceType(file.name);
  if (!sourceType) {
    return { error: '只支持 PDF、Markdown(.md) 和 TXT 文件' };
  }

  /**
   * 先插一条 status = 'pending' 的记录。
   *
   * 为什么不解析完再一次性写入？因为解析会失败（加密 PDF、损坏文件、空文本），
   * 失败本身是用户需要知道的信息 —— 列表里留一条红色的"失败"记录，
   * 比"点了上传就像没上传"强得多。这条记录就是处理过程的审计痕迹。
   */
  const document = await prisma.document.create({
    data: {
      title: file.name,
      sourceType,
      sizeBytes: file.size,
      status: 'pending',
      kbId: kb.id,
    },
  });

  const bytes = new Uint8Array(await file.arrayBuffer());

  try {
    // ① 存原件
    const storageKey = buildStorageKey(userId, document.id, file.name);
    await storage.put(storageKey, bytes, contentTypeFor(sourceType));
    // 立刻记录 key：万一后面解析崩了，这条 key 还在，原件才有机会被回收
    await prisma.document.update({
      where: { id: document.id },
      data: { storageKey },
    });

    // ② 解析成纯文本
    const content = await extractText(bytes, sourceType);
    await prisma.document.update({
      where: { id: document.id },
      data: { content, status: 'processing' },
    });

    /**
     * ③ 切片 + 嵌入（W3）。
     *
     * 这里**故意不写 try/catch**：indexDocument 失败会抛错，落到下面的 catch 里
     * 统一变成 failed + error。如果在这里单独 catch 一次，很容易写出
     * "吞掉异常、状态停在 processing"的静默失败 —— 用户看到的就是永远转圈。
     *
     * 状态流转：pending（已建记录）→ processing（解析完，正在索引）
     *                              → ready（索引完成，可被检索）
     *                              ↘ failed（任一步失败，error 字段写明原因）
     */
    await indexDocument(document.id);
  } catch (error) {
    await prisma.document.update({
      where: { id: document.id },
      data: { status: 'failed', error: readableError(error) },
    });
    return { error: `处理失败：${readableError(error)}` };
  }

  revalidatePath(`/kb/${kb.id}`);

  return {};
}

/**
 * 重建索引：对**已解析成功**（content 非空）的文档重跑 切片 → 嵌入 → 写库。
 *
 * 两个使用场景：
 *   ① 历史遗留：W3 接线之前上传的文档 status=ready 但 chunk 为 0，
 *      W4 的检索会"选中它却搜不出内容"—— 比报错更隐蔽，必须补索引。
 *   ② 环境类失败重试：embedding 服务配错/超时导致 failed 的文档，
 *      修好配置后点这个按钮即可，不用删了重传。
 *
 * 注意它**不重新解析**：content 为 null（解析层就失败）的文档在这里会被拒，
 * 提示重新上传 —— 解析失败的文档本来就没有文本可索引。
 */
export async function reindexDocument(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const userId = await requireUserId();

  const id = String(formData.get('id') ?? '');
  if (!id) {
    return { error: '缺少文档 id' };
  }

  const document = await prisma.document.findFirst({
    where: { id, kb: { userId } },
    select: { id: true, kbId: true, content: true },
  });
  if (!document) {
    return { error: '文档不存在或无权操作' };
  }
  if (!document.content) {
    return { error: '该文档没有解析出的文本，无法重建索引（请删除后重新上传）' };
  }

  await prisma.document.update({
    where: { id: document.id },
    data: { status: 'processing', error: null },
  });

  try {
    await indexDocument(document.id);
  } catch (error) {
    await prisma.document.update({
      where: { id: document.id },
      data: { status: 'failed', error: readableError(error) },
    });
    return { error: `重建索引失败：${readableError(error)}` };
  }

  revalidatePath(`/kb/${document.kbId}`);

  return {};
}

export async function deleteDocument(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const userId = await requireUserId();

  const id = String(formData.get('id') ?? '');
  if (!id) {
    return { error: '缺少文档 id' };
  }

  /**
   * 同样的套路：deleteMany + 用关系过滤做归属校验（`kb: { userId }`）。
   * 分成两步（先查 key 再删）是因为**删完就查不到了** ——
   * 记录一没，对象存储里的原件就再也没人知道叫什么名字。
   */
  const document = await prisma.document.findFirst({
    where: { id, kb: { userId } },
    select: { id: true, storageKey: true, kbId: true },
  });
  if (!document) {
    return { error: '文档不存在或无权删除' };
  }

  const { count } = await prisma.document.deleteMany({
    where: { id, kb: { userId } },
  });

  if (count === 0) {
    return { error: '文档不存在或无权删除' };
  }

  // Chunk 由数据库级联删除；对象存储里的原件得我们自己在归零之前清理
  if (document.storageKey) {
    await removeQuietly(document.storageKey);
  }

  revalidatePath(`/kb/${document.kbId}`);

  return {};
}
