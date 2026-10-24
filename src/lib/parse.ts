/**
 * 文档解析：把上传的文件变成纯文本。
 *
 * 这里是「W2 第二步」的业务核心 —— 它决定了后面切片和检索的上限。
 * 垃圾进来，再好的 embedding 也救不回来。
 */
import type { SourceType } from './file-types';

/**
 * 解出来的文本类型由扩展名决定，不看 file.type。
 *
 * 为什么不看 MIME？因为浏览器给的 MIME 不可靠且不统一：
 * 同一个 .md 文件在不同系统上可能报 text/markdown、text/plain，甚至空字符串。
 * 而文件名用户改不了我不会认错 —— 扩展名是这里唯一稳定的信号。
 */
/**
 * 入参是**字节**，不是 File。
 *
 * 因为同一份字节要用两次（存原件 + 解析文本）。虽然 Blob 可以重复读，
 * 但每次 arrayBuffer() 都是一次完整拷贝 —— 4MB 的文件读两遍就是 8MB 内存浪费，
 * 而这个动作可能并发发生。读一次、传引用，是这里最省的做法。
 */
export async function extractText(bytes: Uint8Array, type: SourceType): Promise<string> {
  const raw = type === 'pdf' ? await extractPdfText(bytes) : decodeText(bytes);

  const text = normalize(raw);

  if (!text) {
    throw new Error('文档没有解析出任何文本内容');
  }

  return text;
}

function decodeText(bytes: Uint8Array): string {
  /**
   * ⚠️ TODO：这里假定文件是 UTF-8。
   * 中文世界里有一大批 .txt 是 GBK/GB18030 编码的（很多下载站、老导出文件），
   * UTF-8 解 GBK 会得到一堆乱码字符（俗称"锟斤拷"），而且**不会报错** ——
   * 它会一路走进向量库，到了问答阶段才变成答非所问。
   * 后续判断方向：解出来乱码字符（U+FFFD）占比高 → 换 GBK 再解一次取更优的那个。
   */
  return new TextDecoder('utf-8').decode(bytes);
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  /**
   * 选用 unpdf（pdfjs 的轻量封装）：纯 JS、零运行时依赖（自带 bundled pdfjs），
   * 没有 canvas / worker 的额外要求，能在 Vercel 的 Node runtime 里直接跑。
   *
   * 这里用**动态** import 是有意的，不是偷懒：pdfjs 这个包体积不小，
   * 静态 import 会让每个上传请求 —— 哪怕只是传一个 1KB 的 .md ——
   * 都把这份代码加载进内存。动态 import 让它只在真的遇到 PDF 时才被拉进来。
   */
  const { getDocumentProxy, extractText } = await import('unpdf');

  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });

  // 不同版本 mergePages 的行为不一致：有的是 string，有的是 string[]，两种都接住
  return Array.isArray(text) ? text.join('\n') : text;
}

/**
 * 规范化：统一换行 + 去掉多余空行 + 去首尾空白。
 *
 * 为什么要在入库前就做：这些空格和换行会原样进 Prompt。
 * 一堆连续空行意味着喂给模型的 token 全是废料 —— 白花钱，还挤占上下文窗口。
 */
function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n') // Windows/Mac 换行统一成 \n
    .replace(/[ \t]+\n/g, '\n') // 行尾空格没意义
    .replace(/\n{3,}/g, '\n\n') // 连续空行压成一个
    .trim();
}
