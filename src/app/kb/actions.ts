'use server';

import { revalidatePath } from 'next/cache';

import { prisma } from '@/lib/prisma';
import { requireUserId } from '@/lib/session';
import { removeQuietly } from '@/lib/storage';

import type { ActionState } from '@/lib/action-state';

/** 重导出：同目录组件继续从 './actions' 引就行，不用关心它实际放在哪。 */
export type { ActionState };

const MAX_NAME_LENGTH = 50;
const MAX_DESCRIPTION_LENGTH = 200;

/**
 * 校验并规范化名称。
 * 抽出来说是因为创建和重命名都要用同一套规则 ——
 * 否则迟早出现"创建时限制 50 字、重命名时忘了限制"这种不一致。
 */
function validateName(raw: FormDataEntryValue | null): { name: string } | { error: string } {
  const name = String(raw ?? '').trim();

  if (!name) {
    return { error: '名称不能为空' };
  }
  if (name.length > MAX_NAME_LENGTH) {
    return { error: `名称不能超过 ${MAX_NAME_LENGTH} 个字` };
  }

  return { name };
}

export async function createKnowledgeBase(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const userId = await requireUserId();

  const validated = validateName(formData.get('name'));
  if ('error' in validated) {
    return { error: validated.error };
  }

  const description = String(formData.get('description') ?? '').trim();
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { error: `描述不能超过 ${MAX_DESCRIPTION_LENGTH} 个字` };
  }

  await prisma.knowledgeBase.create({
    // userId 来自 session，不是来自表单 —— 这一步就是 ownership 的来源
    data: {
      name: validated.name,
      description: description || null,
      userId,
    },
  });

  /**
   * 告诉 Next：/kb 这个页面的数据变了，缓存里的旧结果作废。
   * 不写这行，创建成功后列表还停在旧数据（要手动刷新才看得到）。
   */
  revalidatePath('/kb');

  return {};
}

export async function renameKnowledgeBase(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const userId = await requireUserId();

  const id = String(formData.get('id') ?? '');
  if (!id) {
    return { error: '缺少知识库 id' };
  }

  const validated = validateName(formData.get('name'));
  if ('error' in validated) {
    return { error: validated.error };
  }

  /**
   * ⚠️ 这里用 updateMany，不用 update —— 为了把"没改到"表达成数据，而不是异常。
   *
   * 【先纠正一个常见误解】真正防越权的是 **where 里的 userId**，不是 updateMany 这个函数名。
   * Prisma 的 WhereUniqueInput 支持额外过滤字段（见 generated/prisma/models/KnowledgeBase.ts:210，
   * userId 就在里面），所以 `update({ where: { id, userId } })` 同样改不到别人的东西。
   *
   * 那为什么还选 updateMany？差别在**失败怎么表达**：
   *   update     → 匹配不到就抛 P2025 异常（控制流）
   *   updateMany → 返回 { count: 0 }（返回值，普通的数据）
   *
   * Server Action 里我们要把失败翻译成用户看得懂的话。用异常的话只能 try/catch，
   * 而 catch 会把数据库连不上、网络抖动这些**真故障**一起吞进去，
   * 统统报成"知识库不存在" —— 那才是真正的静默失败。
   * count === 0 是明确的"没改到"，只有这一种含义，可以放心转成可读提示。
   *
   * 代价：updateMany 拿不到更新后的记录、不支持嵌套写。将来若真的需要返回实体，
   * 再换回 update + 精确捕获 P2025 即可。
   *
   * userId 来自 session（`requireUserId()`），不是来自表单 —— 这是整段的安全支点。
   * 提示语统一写成"不存在或无权修改"，不区分这两种情况 ——
   * 否则攻击者可以用返回信息来枚举"哪些 id 真实存在"。
   */
  const { count } = await prisma.knowledgeBase.updateMany({
    where: { id, userId },
    data: { name: validated.name },
  });

  if (count === 0) {
    return { error: '知识库不存在或无权修改' };
  }

  revalidatePath('/kb');

  return {};
}

export async function deleteKnowledgeBase(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const userId = await requireUserId();

  const id = String(formData.get('id') ?? '');
  if (!id) {
    return { error: '缺少知识库 id' };
  }

  /**
   * 同理用 deleteMany + userId，不用 delete —— 理由同上：
   * 我们要的是 count === 0，而不是去 catch 一个语义含糊的 P2025。
   *
   * 数据库层面：Document 的 onDelete 是 Cascade，
   * 所以这个知识库下的 Document → Chunk 会跟着一起删掉，不会留孤儿数据。
   *
   * ⚠️ 但 **级联删不到对象存储**。所以先把即将被删的文档的 storageKey 捞出来，
   * 等数据库删成功之后再逐个清掉 —— 顺序不能反：
   * 先删文件、后删库的话，万一删库失败，文件已经没了，用户的数据彻底找不回来；
   * 反过来最多留个没人能访问的文件（还会被 removeQuietly 记进日志）。
   */
  const documents = await prisma.document.findMany({
    where: { kb: { id, userId } },
    select: { storageKey: true },
  });

  const { count } = await prisma.knowledgeBase.deleteMany({
    where: { id, userId },
  });

  /**
   * ⚠️ 这行不能省。
   * 以前这里删完什么都不返回（Promise<void>），count = 0 时函数静默结束 ——
   * 用户看到的就是"点了没反应"。更糟的是：React 19 会在 action 跑完后自动
   * 重置表单，把隐藏的 id 还原成真值，于是用户**再点一次就成功了**。
   * 系统自己把故障掩盖了，这个 bug 永远不会被人上报，也就永远不会被修 ——
   * 静默失败比报错危险得多，就危险在这里。
   *
   * 提示语同样不区分"不存在"和"无权"，避免被用来枚举真实 id。
   */
  if (count === 0) {
    return { error: '知识库不存在或无权删除' };
  }

  // 数据库已经删干净了，再清理原件（失败只记日志，不影响用户看到的结果）
  for (const doc of documents) {
    if (doc.storageKey) {
      await removeQuietly(doc.storageKey);
    }
  }

  // 只有真的删掉了才刷新。count = 0 说明数据没变化，没必要触发一次重取。
  revalidatePath('/kb');

  return {};
}
