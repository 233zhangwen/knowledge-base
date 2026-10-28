/**
 * 问答流的**协议定义 + 解析器**，前后端共用一份。
 *
 * 为什么要单独抽一个文件：
 *   协议最容易漂移 —— 服务端改了分隔符、前端还按老格式切，两边都不报错，
 *   只是答案少一段或引用全丢。把"怎么编码"和"怎么解码"放在同一个文件里，
 *   至少保证它们永远成对变化。
 *
 * 为什么解析器要是**纯函数**：
 *   流式解析的坑全在边界上 —— 第一行 JSON 被拆成两块到达、
 *   错误哨兵 \u0000 正好卡在两个 chunk 中间。这些场景在浏览器里根本构造不出来，
 *   只有纯函数才能被脚本反复喂各种切法（scripts/verify-stream-protocol.mts）。
 *
 * 流格式（一行一条，正文可含任意换行）：
 *   第一行： {"citations":[...],"conversationId":"..."}\n
 *   之后：   纯文本增量（原样拼进答案）
 *   出错时： 正文里出现 \u0000，其后所有内容都是错误信息
 *
 * 为什么 conversationId 要挤在第一行里（W5 新增，spec A5）：
 *   会话是「第一次提问时」才创建的（spec D2：进页面不创建），而响应已经是流了 ——
 *   再开一个接口去问 id 就得多一次往返，且存在"答案还在生成、前端却拿着老会话"的窗口。
 *   塞在第一行等于搭便车：答案的第一个字到之前，id 一定已经到了。
 */
export type Citation = {
  chunkIndex: number;
  documentId: string;
  documentTitle: string;
  similarity: number;
  content: string;
};

/** 流的第一行：本次检索到的引用 + 这次会话的 id。 */
export type StreamHead = {
  citations: Citation[];
  conversationId: string | null;
};

/** 错误哨兵。流式响应头早已发出 200，中途失败改不了状态码，只能走内协议。 */
export const NUL = '\u0000';

/** 服务端：把首部信息编码成第一行。 */
export function encodeHeadLine(head: StreamHead): string {
  return `${JSON.stringify(head)}\n`;
}

/** 服务端：生成中途失败时追加的哨兵行。 */
export function encodeErrorLine(message: string): string {
  return `\n${NUL}${message}`;
}

export type StreamCursor = {
  /** 第一行 citations 是否还没读完 */
  readingHeader: boolean;
  /**
   * 头部未收全时的暂存区。
   * ⚠️ 不能省：citations 带片段全文，一行常常几 KB，被 TCP 切开到达是常态。
   * 最早的版本直接丢弃没凑齐的半行，结果就是**引用全丢** ——
   * 而且只在网络抖动时偶发，浏览器里几乎复现不了。
   */
  headerBuf: string;
  /** 是否已经遇到哨兵（之后的内容都算错误信息） */
  errorMode: boolean;
  citations: Citation[];
  /** 本次会话的 id（流第一行带来；null = 服务端没给，前端也就没法续聊） */
  conversationId: string | null;
  answer: string;
  error: string;
};

export function createCursor(): StreamCursor {
  return {
    readingHeader: true,
    headerBuf: '',
    errorMode: false,
    citations: [],
    conversationId: null,
    answer: '',
    error: '',
  };
}

/**
 * 喂入一段解码后的文本，就地更新 cursor。
 *
 * 返回 true 表示**这一次**刚解析出 citations（调用方据此决定要不要 setState）。
 * 用就地更新而不是返回新对象：循环里每 20ms 就调一次，没必要造一堆短命对象。
 */
export function feed(cursor: StreamCursor, text: string): boolean {
  let buf = text;
  let justParsedHeader = false;

  // ① 头部：只在还没读完第一行时找第一个 \n。
  //    不能按行随意切 —— 正文里的换行属于答案内容，切错了答案就乱了。
  if (cursor.readingHeader) {
    // 拼上上次没凑齐的半行，再找分隔符
    buf = cursor.headerBuf + buf;
    const nl = buf.indexOf('\n');
    if (nl === -1) {
      cursor.headerBuf = buf; // 还没收全，暂存等下一块
      return false;
    }
    const head = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    cursor.headerBuf = '';
    cursor.readingHeader = false;
    try {
      const parsed = JSON.parse(head) as Partial<StreamHead>;
      cursor.citations = parsed.citations ?? [];
      cursor.conversationId = parsed.conversationId ?? null;
    } catch {
      // 不该发生：服务端第一行一定是 JSON。真发生了就当没有引用，答案照常显示。
      cursor.citations = [];
      cursor.conversationId = null;
    }
    justParsedHeader = true;
  }

  if (buf === '') return justParsedHeader;

  // ② 哨兵可能跨越两个 chunk，所以在累积层面找，而不是逐片判断
  const nul = buf.indexOf(NUL);
  if (nul !== -1) {
    cursor.answer += buf.slice(0, nul);
    cursor.error += buf.slice(nul + 1);
    cursor.errorMode = true;
  } else if (cursor.errorMode) {
    cursor.error += buf;
  } else {
    cursor.answer += buf;
  }

  return justParsedHeader;
}

// ============================================================
// 协议 v2（W10，Agent 路径专用）
//
// 为什么必须有 v2：v1 的 citations 是"流开始前就算好的快照"（必检索架构），
// Agent 化后检索发生在流中间，citations 变成流中产物 —— 第一行装不下它了。
//
//   第一行： {"v":2,"conversationId":"..."}\n
//   事件行： {"citations":[...]}（可多次，客户端按 chunkId 去重合并）
//           {"tool":{"question":"..."}}（检索状态，E2 选做用）
//   哨兵：  \u0001（文本起始标记，服务端发首个文本增量前必发一次）
//   之后：   纯文本增量（与 v1 相同）
//   出错时： \u0000 哨兵（与 v1 相同）
//
// 为什么文本起点必须是哨兵而不能靠"JSON.parse 失败就是文本"来猜：
// 文本增量不按行切 —— 没有换行的答案会被当成"没收全的事件行"扣在缓冲区，
// 实测 bug：回答"你好"全程空白，刷新才显示。边界显式声明，不猜（spec B2 修订）。
// ============================================================

/** v2 第一行：只有会话 id（citations 改走事件行）。 */
export type StreamHeadV2 = {
  v: 2;
  conversationId: string | null;
};

/** v2 事件行（联合判别：有 citations 键是引用事件，有 tool 键是状态事件）。 */
export type StreamEvent =
  | { citations: Citation[] }
  | { tool: { question: string } };

export function encodeHeadLineV2(conversationId: string): string {
  const head: StreamHeadV2 = { v: 2, conversationId };
  return `${JSON.stringify(head)}\n`;
}

export function encodeCitationsLine(citations: Citation[]): string {
  return `${JSON.stringify({ citations })}\n`;
}

export function encodeToolLine(question: string): string {
  return `${JSON.stringify({ tool: { question } })}\n`;
}

/**
 * 文本起始哨兵（W10 修订）：服务端在发第一个文本增量前必发一个 \u0001。
 *
 * 为什么必须有它（实测 bug：回答"你好"时前端全程空白，刷新才显示）：
 * 事件行按 \n 分行，但文本增量不按行来 —— 没有换行的答案会被当成
 * "还没收全的事件行"一直扣在 lineBuf 里，answer 永远是空。
 * 原先靠"JSON.parse 失败就是文本"来猜边界，对没有换行的文本根本不成立。
 * 哨兵是显式声明：事件模式里见到 \u0001 就切文本，不猜。
 * 与 v1 的 \u0000 错误哨兵同一套路：控制字符不会出现在正常内容里。
 */
export const TEXT_START = '\u0001';

export type StreamCursorV2 = {
  readingHeader: boolean;
  /** 半行暂存：头部行、事件行都可能被 TCP 切开（同 v1 headerBuf 的教训） */
  lineBuf: string;
  /**
   * 是否还在事件模式：事件行只出现在文本前（spec B2 的显式约束）。
   * 第一行解析失败（答案以 '{' 开头等）就退出事件模式，之后全部按文本处理。
   */
  eventMode: boolean;
  errorMode: boolean;
  citations: Citation[];
  conversationId: string | null;
  /** 最近一次事件新带来的引用（调用方据此 setState；空数组 = 无新引用） */
  freshCitations: Citation[];
  /** 最近一次工具事件的问题文本（E2 状态提示用；null = 清除） */
  toolQuestion: string | null;
  answer: string;
  error: string;
};

export function createCursorV2(): StreamCursorV2 {
  return {
    readingHeader: true,
    lineBuf: '',
    eventMode: true,
    errorMode: false,
    citations: [],
    conversationId: null,
    freshCitations: [],
    toolQuestion: null,
    answer: '',
    error: '',
  };
}

function isEvent(obj: unknown): obj is StreamEvent {
  if (obj === null || typeof obj !== 'object') return false;
  return 'citations' in obj || 'tool' in obj;
}

/**
 * v2 版 feed。返回值语义与 v1 不同：返回 true 表示**这一次**解析出了新引用
 * （cursor.freshCitations 非空），调用方据此更新引用区。
 */
export function feedV2(cursor: StreamCursorV2, text: string): boolean {
  let buf = cursor.lineBuf + text;
  cursor.freshCitations = [];

  // ① 头部行（v2 结构与 v1 同构，只是字段不同）
  if (cursor.readingHeader) {
    const nl = buf.indexOf('\n');
    if (nl === -1) {
      cursor.lineBuf = buf;
      return false;
    }
    const head = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    cursor.lineBuf = '';
    cursor.readingHeader = false;
    try {
      const parsed = JSON.parse(head) as Partial<StreamHeadV2>;
      // v != 2 说明连错了端点/版本，当协议错误处理（答案照常显示，引用置空）
      cursor.conversationId = parsed.v === 2 ? (parsed.conversationId ?? null) : null;
    } catch {
      cursor.conversationId = null;
      cursor.eventMode = false;
    }
  }

  // ② 事件模式：消费事件行，直到出现文本哨兵（\u0001）或错误哨兵（\u0000）。
  //    事件行必须整行（\n 结尾）才消费；半行留在 buf 等下一块。
  //    JSON.parse 失败的兜底保留（老流/异常流的容错），但正常路径靠哨兵，不靠猜。
  while (cursor.eventMode && !cursor.errorMode) {
    const markerAt = buf.indexOf(TEXT_START);
    const nulAt = buf.indexOf(NUL);
    const boundary =
      markerAt === -1 ? nulAt : nulAt === -1 ? markerAt : Math.min(markerAt, nulAt);

    // boundary 之前的完整行都可以尝试按事件消费
    let regionEnd: number;
    if (boundary === -1) {
      const lastNl = buf.lastIndexOf('\n');
      if (lastNl === -1) break; // 一个完整行都没有，等下一块
      regionEnd = lastNl + 1;
    } else {
      regionEnd = boundary;
    }

    let consumed = 0;
    let textFrom = -1; // 从这里起不是事件，是文本
    while (consumed < regionEnd) {
      const nl = buf.indexOf('\n', consumed);
      if (nl === -1 || nl >= regionEnd) {
        // 哨兵前有不成行的残片（服务端事件行总是整行，正常不该发生）→ 按文本兜底
        textFrom = consumed;
        break;
      }
      const line = buf.slice(consumed, nl);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        textFrom = consumed;
        break;
      }
      if (isEvent(parsed)) {
        if ('citations' in parsed && Array.isArray(parsed.citations)) {
          const fresh = parsed.citations as Citation[];
          cursor.citations.push(...fresh);
          cursor.freshCitations = fresh;
        } else if ('tool' in parsed) {
          cursor.toolQuestion = (parsed.tool as { question?: string })?.question ?? null;
        }
        consumed = nl + 1;
      } else {
        // 合法 JSON 但不是事件（答案恰好以完整 JSON 开头的老兜底）→ 按文本
        textFrom = consumed;
        break;
      }
    }

    if (textFrom !== -1) {
      cursor.eventMode = false;
      buf = buf.slice(textFrom); // 连同边界哨兵一起交给步骤 ③
      break;
    }

    buf = buf.slice(regionEnd);

    if (boundary === nulAt && nulAt !== -1) {
      // 错误哨兵：事件阶段就失败了。buf 现在 \u0000 开头，步骤 ③ 会收进 error
      cursor.eventMode = false;
      cursor.errorMode = true;
      break;
    }
    if (boundary === markerAt && markerAt !== -1) {
      // 文本哨兵：之后是纯文本，buf 交给步骤 ③
      cursor.eventMode = false;
      break;
    }
    // boundary === -1：完整行消费完，残留半行已在 buf，下一轮循环 break
  }

  if (cursor.eventMode) {
    cursor.lineBuf = buf; // 事件模式下残留半行暂存
    return cursor.freshCitations.length > 0;
  }
  cursor.lineBuf = '';

  if (buf === '') return cursor.freshCitations.length > 0;

  // ③ 纯文本模式（与 v1 ② 相同：哨兵在累积层面找）
  // 剥掉可能混进来的文本哨兵（正常路径在②已消费；兜底路径防它漏进步骤③）。
  // 只剥首个：协议里哨兵只出现一次（服务端首 delta 前发一次）。
  const strayMarker = buf.indexOf(TEXT_START);
  if (strayMarker !== -1) buf = buf.slice(0, strayMarker) + buf.slice(strayMarker + 1);
  const nul = buf.indexOf(NUL);
  if (nul !== -1) {
    cursor.answer += buf.slice(0, nul);
    cursor.error += buf.slice(nul + 1);
    cursor.errorMode = true;
  } else if (cursor.errorMode) {
    cursor.error += buf;
  } else {
    cursor.answer += buf;
  }

  return cursor.freshCitations.length > 0;
}
