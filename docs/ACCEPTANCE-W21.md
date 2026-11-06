# ACCEPTANCE-W21：配额与用量——按月问答次数，原子扣减

> 状态：**已完成**（2026-11-06 全量回归通过）
> 前置：W20 完成（`bbed971`）。邀请/角色/组织切换全绿，E2E 7 条
> 项目定位：项目 #2 多租户产品化第 3 周（最后一周）。W19 边界、W20 人与角色，
> W21 回答产品化最实际的那个问题：**一个组织一个月能问多少次，超了怎么办**
> 日期：2026-11-02

---

## 0. 这个 W 不是「加一个计数器」

配额系统的第一直觉：加个 `usedCount` 字段，每次提问 +1，到顶拒绝。
这个写法有一个不会报错的洞和一次必然的重构：

**① +1 不是原子的。**
两个成员在同一毫秒问到最后一题，两个请求都读到 `usedCount = quota - 1`，都 +1，
超发一个。单机自测永远不会撞上，线上只是时间问题。
"读-改-写"三步在任何并发场景下都不是一步 —— 这和 W20 邀请 token 的双击竞态是同一类问题，
只是这次撞的是配额而不是 token。

**② 计数字段必然漂移。**
任何维护累计值的系统都要回答：失败算不算？中断算不算？迁移、回填、手工修数之后
计数器和事实对不对得上？答案是迟早对不上，然后你需要一个"重算"脚本——
而重算的依据是什么？是**事实本身**。

所以本周的核心判断是：**已用量不存累计值，每次从事实现算。**

事实是什么？本月这个组织的 user 消息数。它就是"问了几次"的唯一定义，
永远对得上账，不存在漂移。代价是每次提问多一次聚合查询——
数据量小的时候这是几毫秒；真到了毫秒都嫌多的量级，再上计数器 + 定期对账，
而不是现在就背上漂移风险。**这个取舍要写下来，防止将来有人"优化"回去。**

**③ 检查和占用必须是一个事务。**
"先查还剩多少，没超就发问"在并发下同样不是原子的。做法：事务里
`SELECT ... FROM "Organization" WHERE id=$1 FOR UPDATE` 锁住组织行 →
数本月 user 消息 → 没超就插入这条 user 消息 → 提交。
锁的粒度是组织行，同一组织的提问串行几毫秒，跨组织完全不受影响——
配额本来就是组织级语义，锁在组织行上是"锁的粒度 = 语义的粒度"。

---

## 1. 现状核查

| 项 | 现状 |
|---|---|
| 每答成本 | 已落库：`Message.inputTokens/outputTokens/steps/latencyMs`（W13 D 组），stopped 可空 |
| 成本视图 | `/admin` 近 7 天 answers/token/P95（运维视角） |
| 提问链路 | `chat-agent` route：校验 → `resolveConversation` → `appendUserMessage` → `loadContext` → 流式 |
| 配额 | **零**。任何人可以无限提问，成本只被观测、不被约束 |
| 前端 | ChatPanel 对非 200 已显示 `body.error` 文案 —— 429 不需要改前端就有提示 |

关键事实：**计数的事实基础已经存在**。Message 表 + Conversation.orgId 就是"本月问了几次"的完整事实源，不需要新表来记账。

---

## 2. 设计决策

### D1：已用量现算，不存累计字段

- 已用量 = `count(Message where conversation.orgId=$1, role='user', createdAt >= 月初)`
- **Organization 上只加配额字段，不加用量字段**
- 月初 = UTC 自然月（`date_trunc('month', now())`）。时区知取舍：中国用户月初 8 小时的
  边界差异对配额语义无实质影响，不值得为此引入时区配置
- 索引：现阶段 count 走 `Conversation.orgId` → Message 现有 `(conversationId, createdAt)`，
  数据量小（<1k 行）不需要专门索引。**先记录，到量级再加，不预优化**

### D2：占用 = 事务 + `FOR UPDATE` 锁组织行

```
BEGIN;
  SELECT id FROM "Organization" WHERE id=$1 FOR UPDATE;   -- 串行化同组织的配额判断
  SELECT count(*) ... WHERE orgId=$1 AND role='user' AND createdAt >= 月初;
  count >= quota → ROLLBACK，上层翻译成 429;
  INSERT user 消息;
COMMIT;
```

- 计数口径 = **user 消息数（提问即计）**，不含 assistant 回答。
  同一个事务里完成"检查 + 占用"，超发在结构上不可能
- 提问失败/中断同样占额度：口径就是"问了几次"，与历史里的 user 消息数**永远可对账**。
  这比"成功才计"多出的好处是防刷（每个请求必占名额）——而"成功才计"要定义
  "成功"（complete？stopped 算吗？），定义本身就是漏洞
- quota 来源：`Organization.monthlyAnswerQuota Int?`——null = 用环境默认
  `MONTHLY_ANSWER_QUOTA`（默认 500，必须远大于评测月耗 52，防止 eval:agent 被自己的配额拦住）

### D3：超限行为——429 + 可读文案，不做降级

- route 在 user 消息落库**之前**检查；超限返回 `429 { error: '本月问答额度已用完（N/limit），下月 1 号重置' }`
- ChatPanel 现成的错误显示直接生效，**不改前端**——现有的错误通道能表达，就不新增通道
- 不做"超限降级到纯 RAG/短回答"：配额的语义是硬上限，降级是另一个产品决策，
  混在一起会让"为什么这个回答没有引用"变成排不清的悬案

### D4：可见性——/settings 显示本月用量，/admin 不动

- settings 页给 owner 加一行：`本月问答 N / limit（UTC 自然月）`
- member 不显示（不是他的决策信息）；/admin 已有成本视角，不重复做
- 改配额值不做 UI：MVP 阶段 DB 字段手工改 + env 默认值，先让"配额存在"成立，
  管理界面等有第二个真实组织再说

---

## 3. 验收判据

| 编号 | 判据 | 怎么验 |
|---|---|---|
| **C1** | Organization 有 `monthlyAnswerQuota`（可空），env 默认值生效 | schema 对照 + DB 测试 |
| **C2** | 原子性：并发请求把最后 N 个名额分给恰好 N 个，第 N+1 个被拒 | DB 测试：quota=3 起 5 个并发，恰好 3 个成功 |
| **C3** | 口径可对账：占用后"本月 user 消息数"恒等于已扣名额；失败/中断同样计入 | DB 测试：count 对账断言 |
| **C4** | 超限 429 且 user 消息不落库、不产生半截会话 | DB 测试 + E2E（临时调低 quota） |
| **C5** | 月初重置：上月用满是本月 0 | DB 测试：把一条消息 createdAt 拨到上月 |
| **C6** | 回归不退化：单测/DB/E2E/评测全绿 | 全量回归 |

---

## 4. 显式不做（这一周）

- **金额化计费**：quota 是次数不是钱；金额在 /admin 已有观测，约束用次数
- **owner 改配额的 UI**：DB 手工改 + env 默认，理由见 D4
- **降级回答**（超限给纯 RAG / 短回答）：见 D3
- **按用户/按知识库的细分配额**：配额是组织级语义，细分等真实需求
- **计数器 + 对账任务**：现算方案就是永远对账的，见 D1
- **时区可配**：UTC 自然月，取舍见 D1

---

## 5. 实施记录（2026-11-02 拍板，11-06 收口）

### 5.1 拍板

| 项 | 定案 | 理由 |
|---|---|---|
| 计数口径 | **提问即计**（失败/中断也占名额） | 口径 = 本月 user 消息数，永远可对账；每请求必占名额天然防刷 |
| 默认额度 | **500 次/月**（`MONTHLY_ANSWER_QUOTA`） | 远大于评测月耗（52 问），不会把自己人误伤 |
| 用量可见性 | **owner 在 /settings 看**，member 不看 | 不是 member 的决策信息；kb 页不加，避免 ChatPanel 多一次查询 |

### 5.2 落地

| 文件 | 内容 |
|---|---|
| `prisma/schema.prisma` | `Organization.monthlyAnswerQuota Int?`（null = 走 env 默认） |
| `prisma/migrations/20261102101500_w21_org_quota/` | `ADD COLUMN` 可空列，无数据迁移（代理没开 → Node+pg 直连应用 + 手工登记 `_prisma_migrations`） |
| `src/lib/quota.ts`（新） | `QuotaExceeded` 类型 / `monthStart()` / `resolveMonthlyQuota()` / `countMonthlyQuestions()` / `getMonthlyUsage()` / `consumeMonthlyQuestion()` |
| `src/app/api/kb/[id]/chat-agent/route.ts` | `appendUserMessage` → `consumeMonthlyQuestion`（检查+落库同事务）；捕获 `QuotaExceeded` → 429 + 可读文案 |
| `src/lib/history.ts` | 删掉被取代的 `appendUserMessage`（唯一调用点就是 route） |
| `src/app/settings/page.tsx` | owner 专属一行：`本月问答 N / 500`（`getMonthlyUsage`） |
| `src/app/kb/[id]/ChatPanel.tsx` | 错误提示补 `data-testid="chat-error"`（只加 testid，逻辑未动） |

**实现要点**：
- `consumeMonthlyQuestion` 事务内 `SELECT ... FOR UPDATE` 锁组织行 → count → 超限抛错（事务自动回滚，user 消息不落库）→ 否则插入。
- `$queryRaw` 用标签模板占位符，不拼字符串。
- `QuotaExceeded` 带 `used`/`limit` 两个字段，文案直接拼，route 不用再查一次。
- 计数口径与落库是**同一个 INSERT**——"扣了名额"和"有一条 user 消息"是同一件事的两种说法，不可能不一致。

### 5.3 判据对账

| 编号 | 判据 | 结果 | 证据 |
|---|---|---|---|
| **C1** | 配额字段 + env 默认生效 | ✅ | `resolveMonthlyQuota` 三段优先级：DB 字段 > env > 500 |
| **C2** | 并发原子性：quota=3 起 5 并发 → 恰好 3 成功 | ✅ | `tests/db/quota.test.ts`；**验证过程见 5.4** |
| **C3** | 口径可对账：占用后已用量 ≡ 本月 user 消息数 | ✅ | count 对账断言 |
| **C4** | 超限 429、user 消息不落库、无半截会话 | ✅ | DB 测试 + E2E（临时把 quota 拨 0） |
| **C5** | 月初重置：上月用满 → 本月 0 | ✅ | 把消息 `createdAt` 拨到上月 |
| **C6** | 回归不退化 | ✅ | 见 5.5 台账 |

### 5.4 踩坑：C2「超发」是假的，错的是我的断言

C2 第一次跑红：quota=3、5 个并发，断言 `ok=3` / `rejected=3`——**`ok` 那条从头到尾都是绿的**，
红的是 `rejected`。原因极简单：5 - 3 = **2**，我写成了 3。算术错，不是产品错。

但当时的第一反应是"锁没生效"，于是：

1. 复跑三次确认稳定复现 → 稳定意味着"确定性的错"，而竞态通常是不稳定的 —— **这个信号当时被忽略了**；
2. 绕开 Prisma，用原生 `pg` 经 pooled / direct 两个端点跑同样的"锁→数→插"→ **两边都完美串行（恰好 3 成功）**；
3. 再写 Prisma 事务探针，带查询日志看事务里到底发生了什么 → 打出 `ok=3 rejected=2`，真相才出来。

**这是第四次判据误判**（W16 c12/s05、W17 c22、W18 c16、W21 C2），四次方向完全一致：
**只会把对的判成错的，从不把错的判成对的。**
所以固定动作是：**看到"成绩掉了"先怀疑判据，再怀疑模型/实现。**
本次唯一的新增教训是：**稳定复现不一定是产品 bug**——确定性错误的另一个常见来源是断言本身写错了。
先读断言，再看实现，能省掉后面两步 40 分钟。

### 5.5 收口台账（2026-11-06）

| 项 | 结果 |
|---|---|
| 单测 | **157** 通过（12 文件） |
| DB 测试 | **61** 通过（56 + 配额 5） |
| E2E | **8/8**（kb-flow 3 + invite-flow 4 + quota-flow 1） |
| tsc / lint | 0 / 0 |
| check:scope | 61 文件 32 查询：19 带条件 + 13 白名单 + **0 裸** |
| 评测 | 见下方（W21 未触碰检索/生成，脚本走 `retrieve` + `runAgentTurn`，不经配额层） |

E2E 收获一条日志证据：`{"evt":"agent.quota.exceeded","orgId":"org_e72e","used":1,"limit":0}`
—— 超限被正确观测到，不是静默拒绝。

清理：E2E 建的 2 个测试知识库 + 1 条未消费邀请已从演示库删除；`afterAll` 已把配额恢复 null（验证过）。

### 5.6 遗留

1. **改配额的 UI 没做**（spec 里显式排除）：只能 DB 手工改 / env 默认。
2. **时区是 UTC**：中国用户每月 1 号 08:00 才重置，8 小时边界差异，取舍见 D1。
3. **`migrate status` 未验**：本周和 W20 两条迁移都是代理没开时 Node+pg 直连应用的，
   下次代理开着要一次性确认两条手工登记的 checksum。
