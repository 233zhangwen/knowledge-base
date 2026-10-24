/**
 * 上传文件的类型 / 大小 / 命名规则，集中放在这里。
 * 上传 Server Action、文件输入框的 accept、README 里的说明都引用同一份，
 * 避免"代码限制 4MB、文档写着 10MB"这种自己打自己脸的事。
 */

export const SUPPORTED_EXTENSIONS = ['pdf', 'md', 'txt'] as const;

export type SourceType = (typeof SUPPORTED_EXTENSIONS)[number];

/**
 * 单文件上限 4MB。
 *
 * ⚠️ 这个数字我改过：README 的 ADR 6 里原来拍的是 10MB，那个数字经不起检验 ——
 *   - Vercel Serverless 的**请求体硬上限是 4.5MB**，超过直接被平台掐断，
 *     我们的 Server Action 连被调用的机会都没有；
 *   - Next 的 Server Action 默认 bodySizeLimit 只有 1MB，必须在 next.config 里放开。
 * 留 0.5MB 余量是给 multipart 表单本身的分隔符和字段名用的。
 *
 * 想要突破 4MB，正确做法是**浏览器直传对象存储**（拿签名 URL 从前端 PUT，不走我们的函数），
 * 那是 W7 部署周的事。当前这个上限是 MVP 阶段的务实选择，不是拍脑袋。
 */
export const MAX_FILE_SIZE = 4 * 1024 * 1024;

/** 文件输入框的 accept —— 从同一份常量拼出来，避免手抄漏一个。 */
export const ACCEPT_ATTR = SUPPORTED_EXTENSIONS.map((ext) => `.${ext}`).join(',');

/** 从文件名后缀判断类型。认不出来返回 null，由调用方转成用户可读的错误。 */
export function detectSourceType(fileName: string): SourceType | null {
  const ext = fileName.split('.').pop()?.toLowerCase();
  return SUPPORTED_EXTENSIONS.find((candidate) => candidate === ext) ?? null;
}

export function contentTypeFor(type: SourceType): string {
  switch (type) {
    case 'pdf':
      return 'application/pdf';
    case 'md':
      return 'text/markdown; charset=utf-8';
    case 'txt':
      return 'text/plain; charset=utf-8';
  }
}

/**
 * 生成对象存储的 key：`${userId}/${documentId}-${安全文件名}`。
 *
 * 两个设计点：
 *   1. **userId 当前缀** —— 天然的用户隔离，清理某个用户的数据时按前缀删即可。
 *   2. **文件名要净化** —— 它是用户可控的输入，必须去掉路径分隔符和特殊符号
 *      （storage.put 还会再校验一次，这里是第一道）。
 */
export function buildStorageKey(
  userId: string,
  documentId: string,
  fileName: string,
): string {
  const safeName =
    fileName
      .replace(/[\\/:*?"<>|]/g, '_') // 路径分隔符和 Windows 非法字符
      .replace(/^\.+/, '') // 去掉开头的点：Windows 不允许以点结尾，也不想出现隐藏文件语义
      .slice(0, 80) // 截断超长文件名：数据库字段和文件系统都有长度上限
      .trim() || 'unnamed';

  return `${userId}/${documentId}-${safeName}`;
}
