# W9 验收规格 · 项目 2 第一步：Tool Calling 探针与原型

> 目标读者：三个月后的自己 + 面试官。W6 的规矩延续：**spec 先行、判据可反证、
> 每个拍出来的结论都要有对照**。本 spec 由 p 老师执笔（2026-10-28），修订记录在文末。

## 背景

项目 #1（知识库问答）的检索策略是"每次提问必检索"——简单、可预测，但有两个天花板：

1. **闲聊也检索**：问"你好"也会花一次 embedding + 一次向量查询，结果必然是垃圾片段；
2. **多跳问题做不到**：答案分散在两个文档、需要"先查 A 拿到线索再查 B"时，
   单次检索无解（评测集 c19 的跨块计算是它的弱化版）。

Agent 化的第一步是把"检索"从硬编码步骤变成**模型的工具**：模型自己决定
何时检索、检索什么问句、要不要再检索一次。这就是 function calling。

**本周只回答一个技术问题：这条路在现有技术栈上通不通。**
不动主链路、不接真实检索、不做 UI。

## 核心疑问（探针存在的理由）

`deepseek-flash` 是推理模型，当前用 `thinking: { type: 'disabled' }` 关闭思考。
**推理模型 + 工具调用 + 关闭思考，三者能否共存，没有任何文档保证** ——
这正是探针要实证的。如果模型根本不支持 function calling，后面所有 Agent 设计
都要换前提（换模型 / 换支持工具的推理开关），必须先知道。

## 范围

**做**：
- A 组：零依赖探针 `scripts/probe-tools.mjs`（原生 fetch 直调 /chat/completions，
  与 llm.ts 同源：同 endpoint、同鉴权、同 temperature、同 thinking 参数）
- B 组：AI SDK 原型 `scripts/spike-tools.mjs`（streamText + tools，
  复现 A 组三条 case，记录两侧行为差异）
- C 组：选型结论写进本文件（AI SDK tools vs LangGraph.js，给理由）

**不做**（防止范围爆炸）：
- 不改 `src/lib/llm.ts` / route.ts / 任何页面（主链路冻结）
- 探针里的检索是**假工具**（返回固定片段），只验证协议，不评估检索质量
- 不引入 LangGraph.js / LangChain
- 不做流式下的工具调用（先非流式跑通协议，流式留给接线周）

## 验收标准

### A 组 · 原生探针（零依赖）

- **A1 不该调就不调**：问"用一句话介绍你自己"（与知识库无关）→
  响应**不含** `tool_calls`，`finish_reason === 'stop'`，content 非空。
- **A2 该调就调**：问"星海科技带薪年假有几天？"（知识库专有内容，参数知识答不出）→
  响应含 `tool_calls`，`finish_reason === 'tool_calls'`，参数 `question` 非空且含"年假"。
- **A3 结果回传能续上**：把 A2 的 tool_calls 作为 assistant 消息、
  加一条 role=tool 的结果消息（内含"带薪年假 17 天"）再请求 →
  模型基于结果作答，content 含"17"。
- **A4 参数共存**：A2 的请求体带 `thinking: { type: 'disabled' }` + `temperature: 0`
  仍能拿到 `tool_calls`（报错 / 拒绝 / 忽略 tools 三者任一出现即本条失败）。

### B 组 · AI SDK 原型（需装依赖）

- **B1 依赖就位**：`ai` + `@ai-sdk/openai` 进入 package.json（**必须在他的终端跑
  npm install**——本机沙箱装依赖必失败，见协作约定），lock 文件更新。
- **B2 三 case 复现**：spike 脚本用 `generateText`（非流式）+ `tools` 复现 A1/A2/A3，
  结果与 A 组逐条对照。
- **B3 差异记录**：原生 vs AI SDK 至少记录三点差异
  （请求体差异 / tool_calls 的解析方式 / 非标准参数 thinking 的透传方式），
  追加到本文件"观测记录"。

### C 组 · 选型结论

- **C1**：本文件新增一节"选型：AI SDK tools vs LangGraph.js"，
  至少含三个维度的对比（抽象成本 / 与现有 SSE 链路的兼容 / 错误恢复能力），
  并给出明确选择 + 理由。**允许的结论是"继续用原生"**——前提是理由成立。

### D 组 · 反证（用户手跑）

- **D1 工具真的在起作用**：把 A2 请求里的 `tools` 字段删掉重跑 →
  模型要么说不知道、要么用参数知识编造。记录两种情况下的实际输出。
  （若模型仍"凭空答对 17 天"，说明模型训练数据见过该手册，探针问题要换更偏的。）
- **D2 参数交互探索**：去掉 `thinking` 参数重跑 A2 →
  记录 tool calling 是否仍工作、响应里是否出现 reasoning_content、耗时差异。

## 自我挑漏洞（写 spec 时自己先戳的）

1. **A2 的"该调就调"缺客观判据**——模型可能凭参数知识直接回答。
   对策：问题锚定知识库专有名词（星海科技 / 折旧期 4 年），且 D1 做删工具对照。
2. **A4"共存"定义模糊**。对策：判据已写成三选一的具体失败形态（报错/拒绝/忽略）。
3. **假工具结果会污染结论**。对策：范围里明确"只验证协议不评估质量"；
   B3 的差异记录只看协议层行为，不看答案质量。
4. **探针失败可能是"模型不支持"而非"脚本写错"**。
   对策：A2 失败时换官方 `deepseek-chat` 模型名做对照请求，
   能区分"脚本 bug"与"模型/型号限制"——结论要写明是哪一种。
5. **temperature=0 下"该调就调"可能不稳定**（W6 的教训：只稳命中不稳字面）。
   对策：A2/A3 各连跑 2 次，两次行为一致才算过。

## 观测记录

### A 组 · 原生探针（2026-10-28 实测）

| case | 结果 | 关键数据 |
|---|---|---|
| A1 | PASS | finish_reason=stop，tool_calls=0，934ms |
| A2 ×2 | PASS | 两次均触发 retrieve_knowledge(question 含"年假")，参数逐字节一致；522/667ms |
| A3 ×2 | PASS | 答案含"17 天"；注意出现 markdown 粗体（**17 天**）——工具路径绕过了现有 prompt 的禁 markdown 规则 |
| A4 | PASS | thinking disabled 与 tool calling 共存，无需任何 hack |

**结论：核心疑问有了答案——推理模型 + 工具调用 + thinking disabled 三者可以共存。**

### D 组 · 反证（用户手跑，2026-10-28）

- **D1**（删掉 tools 重跑 A2）：finish_reason=stop、tool_calls=0。模型**没有编造**，
  诚实回答"无法直接给出确切答案，因为这个名称可能对应多家不同公司"，
  并给出一般性判断依据。→ 反证成立：A2 触发工具是因为工具存在且描述生效。
  附带观察：无 system prompt 时模型 markdown 全开（### 标题 / **加粗** / 书名号），
  且 completion=497 token、2625ms（全程最长）——没工具时模型话痨，工具路径反而省 token。
- **D2**（去掉 thinking 重跑 A2）：工具仍触发，但响应出现 reasoning_content（129 字），
  completion 49→78。→ **接线周继续保留 thinking disabled**（关思考是省钱的，不是摆设）。

### B 组 · AI SDK 原型（2026-10-28 实测，ai@7.0.155 + @ai-sdk/openai@4.0.104）

- **B1 依赖就位**：ai@7.0.155 + @ai-sdk/openai@4.0.104 进入 package.json（用户终端安装）。
- **B2 case 复现**：`generateText` + `tool()` + `stopWhen: stepCountIs(5)`：
  - B1 无关问题：toolCalls=0，PASS；
  - B2 多步（A2+A3 合体）：steps=2，工具自动执行（execute 回调真正跑了一次），
    续答含"17 天"，PASS。
- **B3 差异记录**（原生 vs AI SDK，≥3 条）：
  1. **tool_calls 解析与多步循环**：原生要手摸 `choices[0].message.tool_calls`、
     手写"把结果 append 回 messages 再发一轮"的状态机；AI SDK 把整条 loop 包掉
     （execute 自动执行、结果自动回传、steps 聚合），B2 一个 `generateText` 调用完成两轮。
  2. **thinking 透传**：原生直接放请求体；AI SDK 的 providerOptions 是严格 zod schema
     （`@ai-sdk/openai@4` 的 openaiLanguageModelChatOptions，未知键被剥），
     DeepSeek 私有参数唯一通道是 `createOpenAI` 的自定义 `fetch` 中间件
     （spike 里 `INJECT`：解析 body → 注入 `thinking` → 重新序列化）。
  3. **请求体体积**：A1 prompt=321 vs B1 prompt=345——SDK 包装多 ~24 token（可忽略）。
  4. **token 口径改名**：`usage.prompt_tokens/completion_tokens` → `usage.inputTokens/outputTokens`。
  5. **工具定义**：手写 JSON Schema → `tool({ description, inputSchema: jsonSchema(…) })`，
     `execute` 与定义同居一处。
- **两条横跨 A/B 的观察**（不是 SDK 差异，是模型行为）：
  1. **markdown 泄漏是模型层面的**：AI SDK 路径的续答同样出现 `**17 天**` ——
     禁 markdown 规则必须进 Agent 的 system prompt，与传输层无关；
  2. **无 system prompt 时模型自称 Claude**（B1 原话"我是 Claude，Anthropic 开发的 AI 助手"）——
     模型自报身份不可信，也再次说明接线周 system prompt 必须自带身份声明。

### C1 · 选型结论：**AI SDK tools**

| 维度 | AI SDK tools | LangGraph.js |
|---|---|---|
| 抽象成本 | 多步循环/工具执行/结果回传 SDK 全包（B2 实证） | 需先学 graph/node/edge/state 心智模型，为单工具编排引入整套概念 |
| 与现有 SSE 链路兼容 | `streamText` 的 fullStream 有 tool-call/tool-result 事件，前端展示"正在检索"更容易；现有 route.ts 可渐进替换 | 输出是自己的流协议，接回 Next.js SSE 要再包一层 |
| 错误恢复 | 内置 `maxRetries`、`onStepError`，工具异常被捕获为 tool-error 不炸整条流 | 能力更强（checkpoint/时间旅行），但对单工具场景过度设计 |
| 附加收益 | M3 课程要求的官方关键词；provider 可切换靠 `createOpenAI({ baseURL })`，与项目 #1 的抽象一致 | 简历加分但面试要能讲清图模型，学习成本挤占投递期 |

**决定：项目 2 用 AI SDK（ai@7 + @ai-sdk/openai@4 指向 DeepSeek baseURL）。**
保留原生探针脚本作为"SDK 失灵时的对照组"——如果未来遇到 SDK 剥参数之类的坑，
probe-tools.mjs 就是降级路径的可行性证明。

## 修订记录

- V1（2026-10-28）：初版。
- V2（2026-10-28）：B2 由"复现三条 case"合并为两条（A2+A3 合成多步 B2——
  AI SDK 的多步循环本来就是它的主卖点，拆开复现反而测不到 loop）；
  观测记录回填 + C1 选型结论（AI SDK）。
