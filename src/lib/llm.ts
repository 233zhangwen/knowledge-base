/**
 * LLM 生成层：DeepSeek 流式对话（OpenAI 兼容协议，原生 fetch 实现）。
 *
 * 为什么不装 AI SDK（架构决策，写给三个月后的自己）：
 *   W4 用到的只有两件事 —— 流式吐字、透传一个非标准参数 thinking。
 *   AI SDK 的 streamText / useChat / tool-calling 这些 MVP 全用不上；
 *   而 thinking 这种非标准字段要走 providerOptions 透传，会不会被 provider
 *   层吞掉是未知数。原生 fetch + SSE 解析一共 60 行，全部在自己手里。
 *   "provider 可替换"靠的是这个文件的接口边界，不是靠装某个库 ——
 *   将来要换 SDK / 换服务商，只动这一个文件。
 *
 * 实测（scripts/verify-chat.mjs，2026-10-24）：
 *   thinking: { type: 'disabled' } 是唯一有效的关闭方式；
 *   enable_thinking: false 无效（思考 token 照常计费）。
 *   关闭后首字延迟约 630ms，是验收 B1「1.5 秒出首字」的基线。
 */
import PROMPT from './rag-prompt.json';
import type { RetrievedChunk } from './retrieve';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

function readConfig() {
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  const baseUrl = (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');

  if (!apiKey || !model) {
    throw new LlmError('缺少 LLM_API_KEY / LLM_MODEL 配置，检查 .env.local');
  }
  return { apiKey, model, endpoint: `${baseUrl}/chat/completions` };
}

/**
 * 把「历史对话 + 问题 + 检索到的片段」拼成对话消息。
 *
 * System prompt 的规则 3 是 spec A3 / B4 的实现载体：
 * 没有"不许用外部知识"这条硬约束，模型会在文档答案和自己的常识冲突时
 * 不自觉地"纠正"文档 —— RAG 最经典、最难被发现的缺陷。
 *
 * @param history 最近几轮的历史消息，**必定在 system 之后、当前问题之前**。
 *                顺序反了（历史放在问题后面）模型就只能"看着答案猜问题"，
 *                代词追问全部失效 —— 那就是 spec B1 想挡的东西。
 */
export function buildRagMessages(
  question: string,
  chunks: RetrievedChunk[],
  history: ChatMessage[] = [],
): ChatMessage[] {
  /**
   * 编号 [1]..[N] 与 route.ts 下发的 citations 数组**同序** ——
   * 这是 spec C1（引用一致性）成立的前提：前端展示的第 i 条，
   * 就是模型看到的 [i]。两边的顺序只要有一处不一致，引用就全错位。
   *
   * ⚠️ 文本全部来自 rag-prompt.json（W6）：评测脚本读同一份文件拼 prompt，
   * 所以"改 prompt"这个动作在线上和评测里是同一个改动。写死在这里的话，
   * C4-b 会拿线上新 prompt 的答案去和旧 prompt 的评测结果对比，结论无效。
   * replace 一律传函数 —— 否则 chunk 内容里若出现 "{question}" 这种字面量，
   * 会被二次替换（占位符注入）。
   */
  const context = chunks.length
    ? chunks
        .map((c, i) =>
          PROMPT.contextItem
            .replace('{no}', () => String(i + 1))
            .replace('{title}', () => c.documentTitle)
            .replace('{page}', () => String(c.chunkIndex + 1))
            .replace('{content}', () => c.content),
        )
        .join('\n\n')
    : // 一个片段都没召回时也要把话说死，否则模型面对空上下文会自行发挥
      PROMPT.contextEmpty;

  /**
   * 规则编号必须**动态生成**，不能写死 "4." / "5."。
   * W6 往 rules 里加了第 4 条（禁止 markdown）之后，硬编码立刻会变成
   * "4. 只有…" 和 "4. 只允许引用…" 两条并列 —— 编号重复不报错、不影响运行，
   * 但会让后来读 prompt 的模型把它当成同一条，规则优先级失真。
   */
  const rules = [
    ...PROMPT.system.rules,
    chunks.length
      ? PROMPT.system.citationRule.replace('{max}', () => String(chunks.length))
      : PROMPT.system.noContextRule,
  ];
  if (history.length) rules.push(PROMPT.system.historyRule);

  const systemContent = [PROMPT.system.intro, ...rules.map((r, i) => `${i + 1}. ${r}`)].join('\n');

  return [
    {
      role: 'system',
      content: systemContent,
    },
    // 历史夹在 system 与当前问题之间（见注释里的顺序说明）
    ...history,
    {
      role: 'user',
      content: PROMPT.userPrefix
        .replace('{context}', () => context)
        .replace('{question}', () => question),
    },
  ];
}

/**
 * 流式对话：逐段 yield 模型输出的文本增量。
 *
 * 用 async generator 而不是直接返回 ReadableStream —— 调用方（Route Handler）
 * 拿到的是"一段一段的字符串"，想怎么包装都行，不用关心 SSE 解析。
 */
export async function* streamChat(
  messages: ChatMessage[],
  options: { signal?: AbortSignal } = {},
): AsyncGenerator<string> {
  const { apiKey, model, endpoint } = readConfig();

  /**
   * 观测点（spec B2 / B3）：上下文到底带了几条。
   * 结构固定是 system 1 + 历史 N + 当前 user 1，所以历史 = 总数 - 2。
   * 这条日志要能一眼看出"历史是不是被截在上限":第 5 轮之后历史应恒等于 6。
   */
  console.log(
    `[llm] 上下文 ${messages.length} 条（system 1 + 历史 ${Math.max(messages.length - 2, 0)} + 当前 user 1）`,
  );

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      /**
       * signal：用户按「停止生成」→ 前端 abort → 这个 signal 触发 → 上游请求立刻断。
       * 不给它的话，上游会把整条回答生成完，而我们早已不再读了 ——
       * 白付 token，是最典型的"用户以为停了，后台还在烧钱"。
       */
      signal: options.signal,
      body: JSON.stringify({
        model,
        stream: true,
        messages,
        /**
         * temperature 与评测脚本同源（都读 rag-prompt.json 的 sampling）。
         * W6 实测：不设时走服务端默认，同一配置两次跑同一个问题，
         * 一次给"未满折旧期不能换"、一次给"文档中没有相关内容" ——
         * 答案层的"改前/改后对比"因此无法区分是 prompt 起了作用还是抽签。
         */
        temperature: PROMPT.sampling.temperature,
        // 实测唯一有效的关闭思考方式（见文件头注释）
        thinking: { type: 'disabled' },
        // 让最后一个 chunk 带 usage，E2 的成本观测靠它
        stream_options: { include_usage: true },
      }),
    });
  } catch (error) {
    // 用户主动停止：原样抛出，保留 name === 'AbortError'，
    // 让调用方能把它和真正的失败区分开 —— 包装成 LlmError 就把这个信号吞了
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new LlmError(
      `请求 LLM 服务失败（${error instanceof Error ? error.message : String(error)}）`,
    );
  }

  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new LlmError(`LLM 服务返回 HTTP ${res.status}：${detail}`, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // SSE 以空行分块；留最后一块在 buf 里（可能还没收全）
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';

    for (const part of parts) {
      for (const line of part.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;

        let json: {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
        };
        try {
          json = JSON.parse(payload);
        } catch {
          continue; // 半截 JSON 等下一块拼齐再说
        }

        for (const choice of json.choices ?? []) {
          const delta = choice.delta?.content;
          if (delta) yield delta;
        }

        const reasoning = json.usage?.completion_tokens_details?.reasoning_tokens;
        if (reasoning && reasoning > 0) {
          // 不中断服务，但必须在日志里看见 —— 思考 token 是真金白银
          console.warn(`[llm] ⚠️ 本次回答包含 ${reasoning} 个思考 token，检查 thinking 参数是否还在`);
        }
      }
    }
  }
}
