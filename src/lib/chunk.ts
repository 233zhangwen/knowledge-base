/**
 * 文本切片：把一篇文档的纯文本切成若干块（chunk），供后续 embedding 使用。
 *
 * 为什么要有这一层：
 *   embedding 模型有输入长度上限，而且**一块文本越长，它的向量越"平均"**
 *   ——一篇 3 万字的文档压成一个向量，等于把整本书的意思平均掉，检索时
 *   什么都像又什么都不像。切片就是把"检索粒度"定下来：用户问一个具体问题，
 *   我们希望命中的是"讲这件事的那一段"，而不是"整篇文档"。
 *
 * 设计参数（改这里之前先看 docs/ACCEPTANCE-W3.md 的 A 组）：
 *   CHUNK_SIZE    = 500 字 —— 中文 500 字大约是一节内容，够承载一个完整意思
 *   CHUNK_OVERLAP = 80 字  —— 相邻块之间重叠，防止一句话被切两半后两边都检索不到
 */
export const CHUNK_SIZE = 500;
export const CHUNK_OVERLAP = 80;

/**
 * 切分优先级：从"最像语义边界"到"最粗暴"。
 *
 * 顺序很重要 —— 先按空行（段落）切，段落太长再按句子切，句子还太长才按字符硬切。
 * 这样切出来的块尽量是完整的段落/句子，而不是从半句话开始的残片。
 * 中文的句末标点单独列出来，是因为英文那套 "\n\n / \n / 空格" 的分隔符
 * 对中文几乎无效（中文没有空格分词，一整段可以没有一个空格）。
 */
const SEPARATORS = ['\n\n', '\n', '。', '！', '？', '；', '. ', ' '];

/**
 * 把文本切成块。
 *
 * @throws 文本为空时抛错 —— 调用方（index-document）负责把它转成文档的 failed 状态
 */
export function splitText(text: string): string[] {
  // 只做换行统一和去首尾空白；内容本身的规范化在 W2 的 parse.ts 已经做过了
  const normalized = text.replace(/\r\n?/g, '\n').trim();

  if (!normalized) {
    throw new Error('文档内容为空，无法切片');
  }

  const chunks = mergeIntoChunks(splitRecursive(normalized, 0), CHUNK_SIZE);

  return withOverlap(chunks, CHUNK_OVERLAP);
}

/**
 * 递归切分：用当前级别的分隔符切开，仍然过长的片段交给下一级别再切。
 *
 * depth 走到 SEPARATORS 末尾后 sep 为 undefined，splitKeep 原样返回，
 * 最后由 mergeIntoChunks 里的硬切兜底 —— 保证任何输入都能被切开，不会死循环。
 */
function splitRecursive(text: string, depth: number): string[] {
  const parts = splitKeep(text, SEPARATORS[depth]);

  const out: string[] = [];
  for (const part of parts) {
    if (part.length > CHUNK_SIZE && depth + 1 < SEPARATORS.length) {
      // 这一段本身还是太长，换更细的分隔符再切一次
      out.push(...splitRecursive(part, depth + 1));
    } else {
      out.push(part);
    }
  }
  return out;
}

/**
 * 按分隔符切开，但**保留分隔符**。
 *
 * ⚠️ 这一步是 A3（不丢字）能不能过的关键：直接用 split 会把分隔符弄丢，
 * 拼回去就和原文对不上了。丢的是换行和句号这种"不起眼"的字符，
 * 所以这种 bug 不会报错，只会让最终答案少一点东西 —— 必须在这里就防住。
 */
function splitKeep(text: string, sep: string | undefined): string[] {
  if (!sep) {
    return [text];
  }

  const parts = text.split(sep);
  const out: string[] = [];

  parts.forEach((part, index) => {
    const isLast = index === parts.length - 1;
    if (isLast) {
      if (part) out.push(part); // 末尾的空串丢掉，不影响内容
    } else {
      out.push(part + sep); // 把分隔符粘回片段末尾
    }
  });

  return out;
}

/**
 * 贪心合并：把零碎片段拼成尽量接近 CHUNK_SIZE 的块。
 *
 * "尽量接近"而不是"一切到底"是刻意的：碎片块（比如 20 字一块）会让
 * 向量数量暴涨、每块信息量不足。这条对应验收 A1 里的"无故碎片"检测。
 */
function mergeIntoChunks(pieces: string[], limit: number): string[] {
  const out: string[] = [];
  let buffer = '';

  for (const piece of pieces) {
    if (piece.length > limit) {
      // 单个片段就超限（没有任何分隔符可用了，比如一万个字没有标点）→ 硬切
      if (buffer) {
        out.push(buffer);
        buffer = '';
      }
      out.push(...hardSplit(piece, limit));
      continue;
    }

    if (buffer && buffer.length + piece.length > limit) {
      out.push(buffer);
      buffer = piece;
    } else {
      buffer += piece;
    }
  }

  if (buffer) {
    out.push(buffer);
  }

  return out;
}

/** 最后的兜底：按字符数切。走到这里说明文本没有任何可用分隔符。 */
function hardSplit(text: string, limit: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += limit) {
    out.push(text.slice(i, i + limit));
  }
  return out;
}

/**
 * 给每块（第一块除外）前面贴上上一块的尾巴。
 *
 * 为什么要重叠：假设一句话正好横跨块边界 —— 没有重叠时，前半句在第 3 块、
 * 后半句在第 4 块，用户问这句完整的话，两块的向量都不像它，谁都匹配不上。
 * 重叠 80 字能让这句话至少在一块里是完整的。
 *
 * 注意：加了重叠之后单块长度会变成 ≤ CHUNK_SIZE + CHUNK_OVERLAP，
 * 验收 A1 的上限取 580 就是这么来的。
 */
function withOverlap(chunks: string[], overlap: number): string[] {
  if (chunks.length <= 1) {
    return chunks;
  }

  const out: string[] = [chunks[0]];

  for (let i = 1; i < chunks.length; i++) {
    const prev = out[i - 1]; // 用**已加过重叠**的上一块，保证 A2 的断言成立
    const tail = prev.slice(Math.max(0, prev.length - overlap));
    out.push(tail + chunks[i]);
  }

  return out;
}
