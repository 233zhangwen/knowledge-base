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
import { pointerHintText, pointerHints, seenPlaceholder } from './context-budget';
import { fenceMetaLabel, statusOf } from './doc-meta';
import { log } from './log';
import { retrieve, type RetrievedChunk } from './retrieve';
import { fenceChunk } from './untrusted';

/**
 * 多步上限（spec 自我挑漏洞 6）：没有上限的循环 = 没有上限的账单。
 * 一轮"检索→作答"是 2 步；留 6 步给"查 A→查 B→作答"的多跳，再多就该拦了。
 */
export const AGENT_MAX_STEPS = 6;

/**
 * 单轮对话里检索工具的执行上限（W16 成本控制）。
 *
 * 实测：加了指路提示之后，模型会一路查下去 —— 有的题查到 5 次、23k input token，
 * 而正确答案在第 2 次检索时就已经拿到了（多出来的搜索只是在为同一条答案排队）。
 * 步数上限（AGENT_MAX_STEPS=6）管不住这个，因为它同时要留给生成步骤。
 *
 * 3 次的依据：多跳题的实际需要是「首查 → 追指针 → 核版本」，正好 3 步；
 * 单跳题 1~2 步。超过 3 次的都是同一查询的重复劳动（重复率实测 26%）。
 *
 * 超限**不抛错**，而是回一句提示让模型基于已有资料作答 —— 与 retrieve 的降级同一条纪律：
 * 外部约束不该把整轮问答变成错误页。
 */
export const AGENT_MAX_RETRIEVALS = 3;

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
  let repeated = 0;
  const body = chunks
    .map((c) => {
      /**
       * W16：**已见块不再重复注入正文**。
       *
       * 原来这里只做编号复用，正文照旧完整拼一遍 —— 多跳场景下（W16 平均 3.33 次检索）
       * 同一段 500 字会在上下文里出现两三次，模型读几遍、token 付几遍，
       * 而信息量一点没加。
       *
       * 编号仍是复用的（引用不乱），只是正文换成指针。这是无损的：
       * 没删任何信息，只是不再重复同一份。
       */
      const prevNo = ledger.numbers.get(c.id);
      if (prevNo !== undefined) {
        repeated += 1;
        return seenPlaceholder({
          no: prevNo,
          documentTitle: c.documentTitle,
          chunkIndex: c.chunkIndex,
        });
      }

      const no = ledger.numbers.size + 1;
      ledger.numbers.set(c.id, no);
      ledger.citations.push({
        chunkIndex: c.chunkIndex,
        documentId: c.documentId,
        documentTitle: c.documentTitle,
        similarity: c.similarity,
        content: c.content,
      });
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
      /**
       * W17：标题优先用文档内 H1，元数据并进围栏头。
       *
       * `docTitle || documentTitle`：H1 是「星海科技员工手册（2024 版）」，
       * 文件名是「E-星海科技员工手册(2024版).md」—— 后者带着测试脚手架的痕迹
       * （单字母前缀、扩展名），对模型是纯噪声。有 H1 就用 H1。
       *
       * metaLabel 的内容由 doc-meta.ts 算，这里只负责传：
       * 现行版只有日期，已废止版补一句"被谁取代"。
       */
      return fenceChunk({
        no,
        title: c.docTitle || c.documentTitle,
        chunkIndex: c.chunkIndex,
        content: c.content,
        suspicious: c.suspicious,
        metaLabel: docMetaEnabled()
          ? fenceMetaLabel({
              effectiveFrom: c.effectiveFrom,
              status: statusOf(c.effectiveFrom, c.supersededBy),
              supersededBy: c.supersededBy,
              supersededByDocTitle: c.supersededByDocTitle,
            })
          : '',
      });
    })
    .join('\n\n');

  /**
   * 确定性指标（W16）：这一轮检索拿回来 5 块，其中几块是之前已经给过的。
   *
   * 为什么必须记这个而不是看 token：模型的多跳次数本身在波动（同一问题实测 4~5 次），
   * token 总量被次数淹没，去重的效果在里面看不出来。重复块数是**与调用次数无关**的比率，
   * 才是能归因的量。
   */
  log.info('agent.chunks', { total: chunks.length, fresh: chunks.length - repeated, repeated });

  /**
   * 指路提示（W16 B 组）：只在检测到「按《X》执行」时才加一行。
   *
   * 这一行在**围栏之外**，是系统口吻，不是资料内容 —— 与 W14 的围栏纪律一致：
   * 围栏内一律视为原文，围栏外才是给模型的指令。
   */
  /**
   * 只在**最相关的那一块**里找指路句。
   *
   * 全量扫的实测误报率是 100%：问"年假多少天"，top5 里混进研发中心的婚假条款
   * （「按母公司标准执行」），于是每条题都被提示去查母公司手册 —— 那些检索与问题无关，
   * 纯粹是 token 开销。
   *
   * 收窄到 top-1 的逻辑是：**排第一的块如果指向别处，说明答案确实在别处**；
   * 排第五的块顺带提到另一份文件，多半只是同章节的邻居。
   */
  const names = pointerHintsEnabled() ? pointerHints(chunks.slice(0, 1)) : [];
  if (names.length) log.info('agent.pointer', { names });
  return names.length ? `${body}\n\n${pointerHintText(names)}` : body;
}

/**
 * 指路提示的开关（W16 加，W17 改成默认关）。
 *
 * ## 为什么默认关掉了
 *
 * W16 加它是因为 m02 那种「婚假按母公司标准执行」的指针句，当时确实让 m02 从错变对。
 * 但 W17 做了四组对照（`eval/meta-results.md`），发现救 m02 的其实是另一条东西：
 *
 * | 组 | 元数据 | 提示 | 检索/问 | token/问 |
 * |---|---|---|---|---|
 * | A0 | ✗ | ✗ | 2.04 | 6486 |
 * | A1 | ✓ | ✗ | **1.44** | **4641** |
 * | A2 | ✗ | ✓ | 2.25 | 6703 |
 * | A3 | ✓ | ✓ | 1.52 | 4730 |
 *
 * 提示在两种情况下都让检索变多：无元数据时 2.04→2.25，有元数据时 1.44→1.52。
 * 这和 W16 当时的观测方向一致（那次是 1.13→2.63）—— 两次独立实验都指向同一个结论：
 * **在工具结果里追加一句"你要不要再去查一下"，模型就会真的去查**，而大多数时候它
 * 已经拿到了需要的证据。多出来的那一次检索要付一次完整的前向 + 一次完整的上下文。
 *
 * ## 为什么保留代码而不是删掉
 *
 * 它是「元数据抽不到」时的唯一兜底（用户传的是扫描件 PDF、英文文档、或者压根没有
 * 生效日期的内部通知）。数据显示这个兜底现在也不划算，但那是**在当前这 6 篇文档上**
 * 测出来的；换成一份全新的库，结论未必一样。留一个 `AGENT_POINTER_HINT=on` 的成本
 * 是零，删掉之后要重新写一遍 + 重新标一遍单测。
 *
 * ⚠️ 它不是给运维调的产品配置，是评测用的实验条件。线上的行为应该是确定的。
 */
function pointerHintsEnabled(): boolean {
  return process.env.AGENT_POINTER_HINT === 'on';
}

/**
 * 元数据注入的开关（W17 加），默认开。
 *
 * 关掉的场景只有一个：跑对照实验，验证"省下的检索确实是元数据带来的"。
 * 别在生产上关 —— 关了之后模型又回到分不清新旧版的状态，而这个状态不会报错。
 */
function docMetaEnabled(): boolean {
  return process.env.AGENT_DOC_META !== 'off';
}

function makeRetrieveTool(kbId: string, ledger: CitationLedger, budget: { used: number }) {
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
    execute: async ({ question }: { question: string }) => {
      budget.used += 1;
      if (budget.used > AGENT_MAX_RETRIEVALS) {
        /**
         * 第 4 次（含）之后的调用直接拦下。**注意这里仍然返回文本而不是抛错** ——
         * SDK 会把异常当成"工具坏了"回传给模型，模型可能会去解释"检索服务故障"，
         * 那是误导用户。真实原因是我们主动设了预算。
         */
        log.warn('agent.budget_exhausted', { used: budget.used, limit: AGENT_MAX_RETRIEVALS });
        return PROMPT.budgetExhausted;
      }
      const chunks = await retrieve(kbId, question);
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
  const budget = { used: 0 };
  const retrieveTool = makeRetrieveTool(params.kbId, ledger, budget);
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
