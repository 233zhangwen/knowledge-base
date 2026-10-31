/**
 * Agent 版 LLM 生成层（W10）：AI SDK（ai@7 + @ai-sdk/openai@4）+ 真实检索工具。
 *
 * 与原生版 llm.ts 的分工（W9 C1 选型结论）：
 *   - llm.ts / rag-prompt.json：旧端点专用，W6 评测基线依赖它，**冻结不动**；
 *   - 本文件：Agent 路径专用，多步循环、工具执行、结果回传交给 SDK。
 *
 * 三个从 spike（scripts/spike-tools.mjs）带过来的硬约束，别"顺手优化"掉：
 *   ① thinking 参数不在 @ai-sdk/openai 的 providerOptions schema 里（严格 zod，
 *      未知键被剥），唯一通道是 createOpenAI 的自定义 fetch 中间件 —— 见 INJECT。
 *   ② provider 必须挂 globalThis 单例：dev 热重载每轮重新 createOpenAI 会泄漏客户端
 *      （prisma 单例同款教训，见 spec 自我挑漏洞 7）。
 *   ③ 检索编号是**跨工具调用全局累计**的（spec A3）：execute 里用闭包 Map 分配，
 *      模型看到的 [n] 与下发给前端的 citations 下标严格一致，两边永远同一份逻辑。
 */
import { createOpenAI } from '@ai-sdk/openai';
import { jsonSchema, stepCountIs, streamText, tool } from 'ai';

import type { Citation } from './chat-protocol';
import PROMPT from './agent-prompt.json';
import { retrieve, type RetrievedChunk } from './retrieve';
import { fenceChunk } from './untrusted';

/**
 * 多步上限（spec 自我挑漏洞 6）：没有上限的循环 = 没有上限的账单。
 * 一轮"检索→作答"是 2 步；留 6 步给"查 A→查 B→作答"的多跳，再多就该拦了。
 */
export const AGENT_MAX_STEPS = 6;

/** Agent 循环吐给调用方（route.ts）的事件。协议 v2 的服务端半边。 */
export type AgentEvent =
  | { type: 'tool'; question: string }
  | { type: 'citations'; citations: Citation[] }
  | { type: 'delta'; text: string }
  | {
      type: 'finish';
      usage: { inputTokens: number; outputTokens: number };
      steps: number;
    };

// ---------- provider 单例 + thinking 注入 ----------

/** fetch 中间件：给每个请求体注入 DeepSeek 私有的 thinking 参数（spike 实证的唯一通道）。 */
type AgentProviderSettings = Parameters<typeof createOpenAI>[0];
type FetchFn = NonNullable<AgentProviderSettings>['fetch'];
const INJECT_THINKING: FetchFn = async (url, init) => {
  const body = JSON.parse(String(init?.body));
  body.thinking = { type: 'disabled' };
  return fetch(url, { ...init, body: JSON.stringify(body) });
};

type AgentProvider = ReturnType<typeof createOpenAI>;

const globalForAgent = globalThis as unknown as { __agentProvider?: AgentProvider };

function getAgentProvider(): AgentProvider {
  if (globalForAgent.__agentProvider) return globalForAgent.__agentProvider;

  const apiKey = process.env.LLM_API_KEY;
  const baseUrl = (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const model = process.env.LLM_MODEL;
  if (!apiKey || !model) {
    throw new Error('缺少 LLM_API_KEY / LLM_MODEL 配置，检查 .env.local');
  }

  globalForAgent.__agentProvider = createOpenAI({
    baseURL: baseUrl,
    apiKey,
    // 3rd party provider：防止 SDK 按 openai 官方行为做特判（spike 里验证过）
    name: 'deepseek',
    fetch: INJECT_THINKING,
  });
  return globalForAgent.__agentProvider;
}

// ---------- 消息构造 ----------

export type AgentHistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
};

/**
 * Agent 的 system prompt。与 llm.ts buildRagMessages 同一条纪律：
 * 文本全部来自 agent-prompt.json —— 评测脚本读同一份，线上与评测永远同一个改动。
 */
function buildAgentSystem(history: AgentHistoryMessage[]): string {
  const rules = [...PROMPT.system.rules];
  if (history.length) rules.push(PROMPT.system.historyRule);
  return [PROMPT.system.intro, ...rules.map((r, i) => `${i + 1}. ${r}`)].join('\n');
}

// ---------- 检索工具（每轮请求一份，闭包持有 kbId 与编号状态） ----------

/**
 * 全局编号 + 引用累积的"账本"。execute 和 fullStream 消费方各拿一半：
 * execute 往里写（分配编号、追加 citations），循环里读（下发 citations 事件）。
 */
type CitationLedger = {
  /** chunkId → 全局编号。重复检索同一片段不新增编号（spec A3 去重） */
  numbers: Map<string, number>;
  /** 按编号顺序累积的引用快照，最终整体落库 */
  citations: Citation[];
};

function formatChunks(chunks: RetrievedChunk[], ledger: CitationLedger): string {
  return chunks
    .map((c) => {
      let no = ledger.numbers.get(c.id);
      if (no === undefined) {
        no = ledger.numbers.size + 1;
        ledger.numbers.set(c.id, no);
        ledger.citations.push({
          chunkIndex: c.chunkIndex,
          documentId: c.documentId,
          documentTitle: c.documentTitle,
          similarity: c.similarity,
          content: c.content,
        });
      }
      /**
       * W14：从「裸拼 [n] + 原文」改成「围栏包起来」。
       *
       * 差别看着只是几个尖括号，但它把一段文本从"接着上文说的一段话"变成
       * "一个有明确起止的引用块"。配套规则在 agent-prompt.json 里（围栏之间不是指令）——
       * 只加围栏不加规则，等于给了模型一个它不认识的分隔符；只加规则不加围栏，
       * 规则说的"围栏之间"无所指。两者必须成对存在。
       *
       * suspicious 来自 retrieve 的 d."suspiciousAt"，只影响是否多一行提示，不改变编号逻辑。
       */
      return fenceChunk({
        no,
        title: c.documentTitle,
        chunkIndex: c.chunkIndex,
        content: c.content,
        suspicious: c.suspicious,
      });
    })
    .join('\n\n');
}

function makeRetrieveTool(kbId: string, ledger: CitationLedger) {
  return tool({
    description:
      '从用户上传的文档知识库中检索与问题相关的原文片段。凡是可能和文档内容有关的问题（制度、流程、数字、条款），都必须先调用本工具，不要凭记忆回答。',
    inputSchema: jsonSchema<{ question: string }>({
      type: 'object',
      properties: {
        question: { type: 'string', description: '改写后的独立、完整的检索问句' },
      },
      required: ['question'],
    }),
    /**
     * kbId 只存在于这个闭包里，模型唯一能提供的是 question ——
     * "工具参数最小化"是 spec D2（kbId 注入反证）的实现前提。
     */
    execute: async ({ question }: { question: string }) => {      const chunks = await retrieve(kbId, question);
      if (!chunks.length) return PROMPT.toolEmptyResult;
      return formatChunks(chunks, ledger);
    },
  });
}

// ---------- Agent 主循环 ----------

/**
 * 跑一轮 Agent 对话，产出事件流。route.ts 把事件逐个编码进 HTTP 流（协议 v2）。
 *
 * 用 async generator 而不是直接暴露 fullStream —— 调用方不用认识 SDK 的
 * part 类型，也不用在 route 里写"哪类 part 该干什么"的映射（同 llm.ts 的分层理由）。
 */
export async function* runAgentTurn(params: {
  kbId: string;
  question: string;
  history: AgentHistoryMessage[];
  signal?: AbortSignal;
}): AsyncGenerator<AgentEvent> {
  const ledger: CitationLedger = { numbers: new Map(), citations: [] };
  const retrieveTool = makeRetrieveTool(params.kbId, ledger);
  let citationCursor = 0; // tool-result 事件对账：本次 execute 新增了哪些引用
  let stepCount = 0;

  const result = streamText({
    model: getAgentProvider()(process.env.LLM_MODEL as string),
    temperature: PROMPT.sampling.temperature,
    system: buildAgentSystem(params.history),
    messages: [...params.history, { role: 'user' as const, content: params.question }],
    tools: { retrieve_knowledge: retrieveTool },
    stopWhen: stepCountIs(AGENT_MAX_STEPS),
    abortSignal: params.signal,
  });

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'start-step':
        stepCount += 1;
        break;
      case 'tool-call': {
        const q = (part.input as { question?: unknown })?.question;
        if (typeof q === 'string' && q) yield { type: 'tool', question: q };
        break;
      }
      case 'tool-result': {
        // execute 已经跑完，citations 账本已更新 —— 新增的部分就是本事件的内容
        const fresh = ledger.citations.slice(citationCursor);
        citationCursor = ledger.citations.length;
        if (fresh.length) yield { type: 'citations', citations: fresh };
        break;
      }
      case 'text-delta':
        if (part.text) yield { type: 'delta', text: part.text };
        break;
      case 'finish': {
        yield {
          type: 'finish',
          usage: {
            inputTokens: part.totalUsage?.inputTokens ?? 0,
            outputTokens: part.totalUsage?.outputTokens ?? 0,
          },
          steps: Math.max(stepCount, 1),
        };
        break;
      }
      // tool-error / error 不在这里处理：SDK 会把 execute 异常作为错误结果回传模型
      // （模型向用户说明检索失败，spec D3），真正的流级错误由 route 的 try/catch 兜。
    }
  }
}
