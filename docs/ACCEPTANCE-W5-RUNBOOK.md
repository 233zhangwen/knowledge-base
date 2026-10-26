# W5 验收执行手册（19 条，照着做）

> 配套文档：`docs/ACCEPTANCE-W5.md`（判据与"这条在防什么"）。
> 本手册只管**做什么、敲什么命令、看到什么算过**。
>
> 约定：`<kbId>` = 你的知识库 id（`/kb/<kbId>` 地址栏里有），`<convId>` = 会话 id。
>
> **PowerShell 里查库命令怎么写（照抄就行，别自己发明）**
>
> 一律用 **管道 + `--stdin`**，不要写成 `node scripts/db-query.mjs 'SQL'` 的形式：
>
> ```powershell
> 'select count(*)::int from "Conversation";' | node scripts/db-query.mjs --stdin
> ```
>
> 原因：PowerShell 把参数传给**原生命令**（node.exe）时会吃掉一层双引号，
> 到达 Node 的 SQL 变成 `from Conversation`，Postgres 直接报
> `relation "conversation" does not exist`（表是用引号建的混合大小写，大小写敏感）。
> 走 stdin 就没有这层重解析。`node scripts/db-query.mjs` 不带参数仍是跑 W3 预设。
>
> SQL 里的字符串字面量（如 `'user'`）在 PowerShell 单引号串里要写成**两个单引号** `''user''`。

---

## 0. 开工前的一次性准备

```powershell
cd /d/code/knowledge-base

# ① 确认迁移已生效（没有这个字段，D4 永远验不过）
'select count(*)::int from information_schema.columns where table_name=''Message'' and column_name=''finishReason'';' | node scripts/db-query.mjs --stdin
#   期望 1；是 0 说明迁移没跑，先 npx prisma migrate deploy

# ② 看看现在库里有什么（后面每条判据都要拿它做"前/后对比"）
'select count(*)::int as conv from "Conversation";' | node scripts/db-query.mjs --stdin
'select count(*)::int as msg from "Message";' | node scripts/db-query.mjs --stdin

# ③ 准备三个专用知识库（避免互相污染）
#    W5-A：放 C-星海科技员工手册-完整版(B1专用).md   ← 专供 B 组
#    W5-B：放 A / B 两份 fixture                      ← 专供 E1 回归
#    W5-C：空的，专供 A6/C1/C2 的 seed 造数，验收完直接删库
```

**一条万能查询**（几乎每条判据都要用它看"当前会话长什么样"，建议常驻剪贴板）：

```powershell
'select left(c.id,8) as id, left(coalesce(c.title,c.id),22) as title, string_agg(m.role || '':'' || left(m."finishReason",1), '' '' order by m."createdAt") as seq from "Conversation" c left join "Message" m on m."conversationId"=c.id group by c.id order by c."updatedAt" desc limit 10;' | node scripts/db-query.mjs --stdin
```

`seq` 那一列读法：`user:c assistant:c` = 一问一答都完整；
`user:c` 单独一条 = **孤儿**（D5 要验它有没有 UI 交代）；
`assistant:s` = 停止生成落库的半成品（D4）。
> `finishReason` 只有 `complete` / `stopped` 两个值，**没有 failed** —— 生成失败时压根不写 assistant，
> "没答案"是由"最后一条是 user"推断出来的。这是刻意的：少一个状态，少一份要维护的语义。

**四条观测日志**（dev 终端，验之前确认它们会打出来，看不到就先别往下走）：

```
[chat] conversation=<id> new|reuse      ← A5/D2 用
[chat] 第 N 轮 kb=... conv=... 历史 M 条  ← B2/B3/D3 用
[chat] conv=... 首字 XXXms（含检索）      ← E1/B1 用
[chat] conv=... 总耗时 YYYms             ← D3 用
```

---

## 批次 ① 纯手点（不动环境，一口气跑完）

### D2 未提问不建会话
1. 记个数：`'select count(*)::int from "Conversation";' | node scripts/db-query.mjs --stdin`
2. 打开 `W5-A` 详情页，**什么都不问**，刷新两次页面
3. 再数一次 → **必须和 ① 完全相同**
- 🔴 数字变大了：进页面就建会话。侧栏很快会被几十个"新对话"刷屏。

### A1 刷新不丢
1. 问一句：`年假有多少天？` → 等答案流完
2. **F5 刷新** → 问答原样出现（用户在上、助手在下），顺序正确，不用点任何东西
3. 查：`'select c.title, count(m.id)::int from "Conversation" c join "Message" m on m."conversationId"=c.id group by c.id;' | node scripts/db-query.mjs --stdin` → `count = 2`
- 🔴 刷新后空了：消息只在前端 state 里，没落库。

### A4 标题自动生成且没偷偷调 LLM
1. 侧栏这个会话的标题 → 应等于你那句提问（超过 20 字截断加 `…`）
2. 数 dev 终端里这次提问打了几行 `[chat]` → **只能有一轮日志**（1 新建 + 1 首字 + 1 总耗时 = 3 行，但没有第二次 LLM 请求）
- 🔴 标题是"总结一下"这类摘要腔：说明为标题调了 LLM，首轮平白多花几百毫秒。

### A5 会话 id 能回到前端 + 生成途中刷新找得回来
1. **接着在上面那个会话再问一句**（别点"新对话"）
2. 看日志出现 `conversation=<id> reuse`（不是 `new`）；查上面的万能查询：两条消息**在同一个 id 下**
3. 新会话重试同一流程：**答案还在吐的时候按 F5** → 刷新后侧栏最新一项的标题是你那句提问，点进去能看到它
- 🔴 每次提问都 `new`：id 没透传（走的是流第一行 `{"citations":...,"conversationId":...}`），历史会被撕成一地碎片。

### E2 新旧会话互不干扰
1. 会话 1 聊 3 轮 → 点「新对话」→ 输入框和消息区都清空 → 问一个完全无关的问题
2. 第 ③ 步的答案里**不能出现会话 1 的内容**
3. 点回会话 1，3 轮原样还在

### D3 10 轮长会话不崩
1. 同一会话连问 **10 轮**
2. 第 10 轮仍能出答案；dev 日志里 `历史 M 条` 稳定在 **6**，不随轮数涨
3. 第 10 轮的 `总耗时` 不比第 1 轮明显慢
- 🔴 上下文泄漏：先看 `history.ts` 的 `loadContext` 是不是写成了 `orderBy asc, take`（那取到的是**最老的** 6 条，不报错，只是多轮永远停在第一轮）。

---

## 批次 ② 中断类（区分两个不同的中断）

> ⚠️ **先看这段，否则你会把正确行为判成失败**
> `route.ts` 里有一条 `cancel()` 回调：客户端断开时它会 `persistAssistant('stopped')`。
> 所以**关标签、点停止、前端 abort 都会落库一条 `finishReason=stopped` 的半截答案** —— 这是 D4 要的。
> 只有**进程被硬杀**（来不及跑任何 catch/回调）时才会出现 `user=1 assistant=0` —— 那是 A2 要的。
> 两种中断判据不同，别混着验。

### A2 落库顺序（必须硬杀进程）
```powershell
# 1) 打开浏览器提一个长问题（"把所有条款总结一下"），等它开始吐字
# 2) 到跑着 dev server 的那个终端，Ctrl+C 停掉它（进程级中断）
# 3) 立刻查：
'select role, count(*)::int from "Message" group by role;' | node scripts/db-query.mjs --stdin
```
**判绿：`user` 至少 1、`assistant` 比预期少 1**（最后那 Assistant 没写成）。
- 🔴 `user=0`：提问没先落库 —— 崩溃时用户连自己问过什么都找不回来。
- （用 `curl -N` 打接口 Ctrl+C 也行，但**必须带登录 Cookie**，否则 `requireUserId()` 直接 401，
  连 ① 那步都到不了。硬杀进程是更省事的那条路。）

### D4 停止生成：落库 + 有标记 + 刷新仍在
1. 提一个长问题，吐到一半点「停止生成」
2. 答案区**保留**已生成的部分，下面一行灰字 **"已停止生成（内容可能不完整）"**，不显示红字错误
3. 查库：`seq` 里出现 `assistant:s`；**F5 刷新**后那条半截答案和灰字标记**都还在**
4. 紧接着再问一句 → 能正常回答（不会因为上一条残缺就畸形，见 `loadContext` 里那段
   `while (ordered[0].role !== 'user') shift()`）

---

## 批次 ③ 改坏配置（D1 + D5 一次操作两个面）

```powershell
# 1) 改 .env.local：LLM_API_KEY=sk-错的一串
# 2) 重启 dev server（必须的，env 只在启动时读）
# 3) 新会话提问 → 答案区红字："生成失败：……"
# 4) 刷新 → 那条提问下面出现灰字："这次提问没有拿到回答（生成失败或被中断）。可以直接重新提问。"
# 5) 查库：
'select role, count(*)::int from "Message" group by role;' | node scripts/db-query.mjs --stdin
```

**判绿（两条一起看）**：
- **D1**：`assistant` 没有出现这次的半成品 —— 库里没有空回答或半截回答
- **D5**：界面上那条孤单的 user 消息**有可见交代**（上面的灰字），不是空空如也

🔴 只看界面、不看库不算过；🔴 如果库里出现一条内容为空的 assistant 气泡 ——
说明 `persistAssistant` 里的 `if (!answer.trim()) return;` 被删掉了。

**验完改回正确的 key 并重启。**

---

## 批次 ④ 造数据（A6 / C1 / C2）

```powershell
node scripts/seed-conversations.mjs                            # 列出知识库 id
node scripts/seed-conversations.mjs --kb=<W5-C的id> --bulk=25  # A6
node scripts/seed-conversations.mjs --kb=<W5-C的id> --bait     # C1 诱饵
```

### A6 列表上限 20
- 造完 25 个会话 → 侧栏**只显示 20 个**，按最近更新排（最近创建/更新那个在最上面），最老 5 个不见了
- 点最后一个（第 20 个）能正常打开
- 🔴 显示了 25 个：`listConversations(..., take: 20)` 没生效；🔴 丢的是最新的：排序写成了 `createdAt`。

### C1 别人的会话打不开（**必须做反证**）
1. 记下 `--bait` 输出的 `<convId>`（它的 `userId` 是伪造的其他人）
2. 浏览器打开 `http://localhost:3000/kb/<kbId>?c=<convId>` → **看不到内容**（404 / notFound），不是报错崩页面
3. **反证**：临时把 `src/lib/history.ts` 里 `loadConversationMessages` 的 `where: { id: conversationId, userId }`
   改成 `{ id: conversationId }`，重启 → **必须能看到那条诱饵**。看不到说明诱饵没插进去，前面的"绿"是假的。
4. 改回来。
> 顺带一个印证：seed 脚本之所以要**先插一个假 User** 才能插诱饵会话，正是因为
> `Conversation.userId → User` 有外键。这条外键说明那个过滤不是装饰品。

### C2 会话和知识库必须一致
1. 拿 `W5-A` 里的会话 id，拼到 `W5-B` 的 URL：`/kb/<W5-B的id>?c=<W5-A的convId>` → 打不开
2. 或者：如果 URL 能正常渲染出来（说明只做了 C1 没做 C2 的页面侧校验），在那个页面上提问
   → 接口必须返回 **404** `会话不存在`（`resolveConversation` 里的 `userId + kbId` 双查）
- 🔴 能进去还能问：上下文串到别的库去了，检索却发生在当前库 —— 表现出来只是"答案有点怪"，极难发现。

---

## 批次 ⑤ 删库级联（C3）

在 `W5-C` 里聊 3 轮 → 删掉这个知识库 →：

```powershell
'select count(*)::int from "Conversation" where "kbId"=''<W5-C的id>'';' | node scripts/db-query.mjs --stdin
# 期望 0
'select count(*)::int from "Message" m left join "Conversation" c on m."conversationId"=c.id where c.id is null;' | node scripts/db-query.mjs --stdin
# 期望 0（孤儿消息）
```
⚠️ 判据必须带 `where kbId`：全表 count 回 0 只在"你只在这一个库聊过"时成立，换个场景就会误判。

---

## 批次 ⑥ 多轮上下文（B1 / B2 / B3，用 W5-A）

> 前置：`W5-A` 里必须先传了 **`C-星海科技员工手册-完整版(B1专用).md`** 并索引完成。
> 它实测切成 **9 块 > TOP_K=5**，检索必须真的做筛选。用 1400 字的老 fixture 只有 3~4 块，
> **会被全量召回，这条判据会假绿**。

### B1 ⭐ 零信息量追问能接住
```
Q1：年度额度最高的是哪一项？        → 必须答 8000 元培训基金
Q2：那第二多的那项呢？              → 必须答 3000 元团队建设费
```
- Q2 整句不含任何文档名词，靠检索几乎捞不到东西 —— 看 dev 日志 `[retrieve]` 的 top1 相似度应明显偏低
- **反证（必做）**：把 `src/lib/history.ts` 的 `export const HISTORY_TURNS = 3` 改成 `0`，重启，
  重问 Q2 → **必须答不上来**（回"文档中没有相关内容"或答错）。
  仍然答对 = 追问句里混进了可检索的词，换一句再验。**验完改回 3。**
- 🔴 Q2 答不上来且上下文正常：看 `buildRagMessages` 的第三参 `history` 有没有真的传进去，
  以及它是不是夹在 system 和**当前 user 之间**（顺序错了等于没上下文）。

### B2 ⭐ 上下文上限 6 条 + 历史不带引用
连问 5 轮，看日志 `[chat] 第 5 轮 ... 历史 6 条`（不是 8 条、不是 10 条）。
再在 `buildRagMessages` 里临时 `console.log(JSON.stringify(messages))`，数 `参考资料：` 出现几次 →
**只能 1 次**（当前这轮）。多次 = 历史消息把自己的 citations 也带进去了，token 翻倍买噪声。
（看完把临时 log 删掉。）

### B3 同上（同一处证据，两条判据一起勾）

---

## 批次 ⑦ 回归（E1）

把 key 改回对的、环境变量恢复、`HISTORY_TURNS=3`，然后在 `W5-B`（A/B 两份 fixture）重测 W4 的十四条。
四条重点：**A1 跨库隔离**（接口改造最容易顺手删掉某个 where）、**B1 流式**（见下方订正）、
**B4 常识污染**（prompt 变了，规则可能被挤到后面）、**B2 引用一致性**（多轮之后编号容易重排）。

> **B1 流式的判据已订正**（原 spec 写死的 `Content-Type: text/event-stream` 是错的 —— 我们自己定的是
> `text/plain` + 自定义行协议，用它判会假红）。正确硬证据是：
> ① dev 日志里 `首字 XXXms` 与 `总耗时 YYYms` **差距明显**（例如 631ms vs 8000ms）——
> 一次性返回的话这两个数必然相等；
> ② Network 面板里该请求在答案吐完前一直处于 pending，且 Response 内容随时间在增长。
> 肉眼看到打字机效果不算证据（前端可以假流式）。

---

## 清理

```powershell
node scripts/seed-conversations.mjs --clean
```

---

## 打分表

| # | 场景 | 结果 | 备注 |
|---|---|---|---|
| A1 | 刷新不丢 | ☐通过 ☐失败 | |
| A2 | user 先落库（硬杀进程） | ☐通过 ☐失败 | ⚠️ 不能用"点停止"代替 |
| A3 | 删文档后历史引用仍可读 | ☐通过 ☐失败 | ⭐ 见下 |
| A4 | 标题自动生成、无额外 LLM | ☐通过 ☐失败 | |
| A5 | id 透传 / 生成中刷新能找回 | ☐通过 ☐失败 | |
| A6 | 列表上限 20（按最近更新） | ☐通过 ☐失败 | 需 seed 25 条 |
| B1 | 零信息量追问 + take 0 反证 | ☐通过 ☐失败 | ⭐ 需 9 块文档 |
| B2 | 上下文上限 6 条 | ☐通过 ☐失败 | |
| B3 | 历史不带 citations | ☐通过 ☐失败 | `参考资料：` 只出现 1 次 |
| C1 | 跨用户隔离（含反证） | ☐通过 ☐失败 | ⭐ 安全事故级 |
| C2 | 会话与 kbId 一致 | ☐通过 ☐失败 | |
| C3 | 删库级联清理 | ☐通过 ☐失败 | count 必须带 kbId |
| D1 | 失败不留半成品 | ☐通过 ☐失败 | |
| D2 | 未提问不建会话 | ☐通过 ☐失败 | |
| D3 | 10 轮不崩、历史恒 6 | ☐通过 ☐失败 | |
| D4 | 停止生成：落库 + 有标记 + 刷新仍在 | ☐通过 ☐失败 | ⭐ |
| D5 | 孤儿 user 消息有可见交代 | ☐通过 ☐失败 | |
| E1 | W4 十四条回归 | ☐通过 ☐失败 | B1 判据已订正 |
| E2 | 新/旧会话互不干扰 | ☐通过 ☐失败 | |

> **A3 没写进批次**：它需要一个"带引用的历史回答 + 之后把那个文档删掉"的场景。
> 做法：在 `W5-A` 问出带引用的答案 → 截图引用文本 → 删除那个文档 → 刷新该会话 →
> 引用仍能展开、**显示的还是当时那段原文**。放在最后做（删了文档就没得回头了）。
