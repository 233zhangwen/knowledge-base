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
