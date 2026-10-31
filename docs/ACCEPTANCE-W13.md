# W13 验收：CI/CD + 可观测

> 前置：W12 收口（单测 47、DB 6、E2E 3 全绿，commit `a6e0a2f` 系列）。
> 本周目标不是加功能，是让项目**在没人盯着的时候也能自己证明自己没坏**
> —— 每次 push 自动验，线上出事能查到"哪一步、哪一版、花了多少钱"。

## 0. 现状盘点（写 spec 前实测，不是猜的）

| 项 | 现状 |
|---|---|
| CI | **完全没有**（无 `.github/`）。测试只有本地手工跑 |
| 日志 | 14 处裸 `console.*`，格式是给肉眼看的中文串，机器没法按字段过滤 |
| 错误收集 | 无。`error.tsx` 只在浏览器 console 打一行，关掉页面就没了 |
| 健康检查 | `/api/health` 已有（DB 探活 + commit + 延迟），W7 建的，够用 |
| 成本可见性 | 无。`finish` 事件里已经算了 `steps/tokens/耗时`，但**只打印到日志，没落库** |
| 管理视图 | 无 |

## 1. 范围与不做

**做**：CI 流水线 / 结构化日志 / 错误持久化 + 查看页 / 每答成本落库 + 统计页 / README 补齐

**不做**（写进 README，别偷偷做）：
- 分布式追踪（OpenTelemetry）—— 单实例应用，链路追踪的收益远小于接入成本
- 告警通道（邮件/企微机器人）—— 没有真实用户，告警没人收；等有用户再说
- 日志外部存储（Loki/ES）—— 免费层日志量远到不了需要外部存储的量级
- 前端性能监控（Web Vitals 采集）—— Next 自带的够看，不值得为它引依赖

## 2. A 组：GitHub Actions CI

### A1 流水线分级

| job | 触发 | 内容 | 需要 secret | 时长预算 |
|---|---|---|---|---|
| `static` | 每次 push / PR | `tsc --noEmit` + `eslint` + `vitest run tests/unit` | 无 | < 2 min |
| `build` | 每次 push / PR（依赖 static） | `npm ci` + `prisma generate` + `next build` | 无（用假 DATABASE_URL） | < 4 min |
| `db` | **手动** `workflow_dispatch` | `RUN_DB_TESTS=1 vitest run tests/db` | `DATABASE_URL` + `DIRECT_URL` | ~1 min |
| `e2e` | **手动** `workflow_dispatch` | Playwright 三条链路 | `E2E_AUTH_STATE`（base64 的 state.json） | ~5 min |

**为什么 db/e2e 不跟着 push 跑**：
- `db` 直连生产 Neon 库，跑测试要写真实行。测试会自清理，但"每次 push 都往生产库写一遍"
  不是个好习惯，且免费层有连接数限制。
- `e2e` 依赖 GitHub OAuth 的 cookie（`state.json`），**它会过期**。放进必跑流水线，
  某天凌晨会突然全红，而那时候你在睡觉——红的原因和代码毫无关系。
  这是"为了绿而绿"的典型陷阱：**必然过期的凭证不该当门禁**。

### A2 缓存与锁文件

- `npm ci` 而不是 `npm install`（CI 必须锁文件精确复现，不接受任何隐式升级）
- `actions/setup-node` 的 `cache: npm`
- Node 版本固定 **24**（本机实测 v24.22.0；`engines` 若未声明则补上）
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 在 CI 的 env 里也设（`npm ci` 会触发 install 脚本）

### A3 build job 的坑（预判，实施时验证）

`next build` 会做静态预渲染。任何在构建期执行到 `prisma` 的页面都会连库，
CI 没有可用的库 → 构建失败。预期两条路：
1. 相关页面本来就是 `dynamic`（有 `auth()` 调用）→ 构建期不执行，无需处理；
2. 有页面被误判为静态 → 用假 `DATABASE_URL` 顶住（`postgresql://u:p@127.0.0.1:1/none`），
   **不能**给真库，也不能跳过 build 校验。

> A3 的判定标准：`build` job 在无 secret 情况下通过，且失败时能看到是"缺环境变量"而不是被 `--no-verify` 之类的开关绕过。

### A4 门禁

- PR 模板要求自检项（可选，仓库单人开发，价值有限，写进 spec 但可跳过）
- README 顶部加 CI badge，指向 `static` job

## 3. B 组：结构化日志

### B1 设计

新增 `src/lib/log.ts`（零依赖，约 40 行）：

```ts
log.info('agent.turn.start', { kbId, convId, turn, historyLen })
log.warn('llm.thinking_tokens', { tokens })
log.error('agent.generate.failed', { convId, message, stack })
```

- 输出形态：**单行 JSON** `{"t":ISO,"lvl":"info","evt":"agent.turn","...fields"}`。
  理由：Netlify 的函数日志按行收集，单行 JSON 能直接被平台按字段过滤/搜索；
  人看的彩色串在机器眼里就是一坨。
- 分级：`debug < info < warn < error`，由 `LOG_LEVEL` 控制（默认 `info`，本地 dev 可 `debug`）
- **敏感字段过滤**：`question`/`content` 这类用户输入默认**不落日志**（只落长度与 hash 前缀），
  理由同 `/api/health` 只报布尔——日志会被转发、被截图、被贴进 issue。
- 不在客户端用（`log.ts` 只 import 到 server 侧；client 侧保持 `console.error`）

### B2 迁移范围

只改**有诊断价值**的 6 处，不搞全量替换（为了统一而统一是负担）：
1. `chat-agent/route.ts`：4 处（轮次开始 / 检索 / 完成 / 失败）
2. `lib/retrieve.ts`：召回条数与 top1 相似度
3. `lib/llm.ts`：usage 与思考 token 告警
4. `lib/history.ts`：会话新建/复用（debug 级）
5. `lib/storage.ts`：孤儿文件删除失败（error 级，这条必须保留上下文 key）
6. `api/health/route.ts`：探测失败

### B3 反证

`LOG_LEVEL=error npm run dev` 时，`info` 级日志必须完全不出现（证明分级真的生效，
不是"写着玩的参数"）。

## 4. C 组：错误持久化 + 查看页

### C1 数据模型

```prisma
model ErrorLog {
  id        String   @id @default(cuid())
  level     String   // error | warn
  event     String   // 事件名，如 agent.generate.failed
  message   String
  stack     String?
  path      String?  // 出错的页面/接口
  digest    String?  // React error digest / requestId，用来和服务端日志对上
  count     Int      @default(1)   // 相同 fingerprint 的重复次数
  firstSeen DateTime @default(now())
  lastSeen  DateTime @default(now())

  @@unique([fingerprint])
  @@index([lastSeen])
}
```

- `fingerprint` = `sha1(event + message 前 200 字 + path)`，同错只累加 count、更新 lastSeen。
  **理由**：一次故障会刷出几百条同错，不合并的话查看页第一天就废了。
- 写入失败必须**静默**（`void reportError(...).catch(() => {})`）：错误上报把主流程带崩，
  是最典型的"监控把自己变成故障源"。

### C2 上报入口

| 入口 | 时机 |
|---|---|
| `error.tsx` | 客户端渲染错误 → 调 `POST /api/errors`（带 digest） |
| `chat-agent/route.ts` catch | Agent 生成失败（已有，改为双写：日志 + DB） |
| Server Action catch | 上传解析失败、建库失败 |

**限流**：`/api/errors` 按 fingerprint 做进程内节流（同 fingerprint 60 秒内最多写 1 次），
防止前端死循环刷爆库。

### C3 查看页 `/admin`

- 访问控制：`ADMIN_EMAIL` 环境变量 + `auth()` 的 session email 比对；未配置 → 页面 404（不是 403，
  不给探测者"这里有个管理页"的信息）。
- 内容：最近 50 条（level / event / message / count / lastSeen / path），点击展开 stack。
- 不做：删除、搜索、分页（有需要再说，先证明"能看到"）。

## 5. D 组：每答成本落库 + 统计

### D1 模型改动

`Message` 加 4 个可空字段（老数据不用回填）：

```prisma
inputTokens  Int?
outputTokens Int?
steps        Int?     // Agent 跑了几个 LLM 步
latencyMs    Int?
```

### D2 写入

`chat-agent/route.ts` 的 `finish` 事件里已经有 `usage.inputTokens / outputTokens / steps`，
把它们和 `Date.now() - t0` 一起传给 `appendAssistantMessage`。

### D3 统计视图

`/admin` 同页第二块（或 `/admin/cost`）：
- 近 7 天：回答数、总 input/output tokens、平均 steps、平均延迟、P95 延迟
- 按库分组的 top5（哪个知识库最烧钱）
- **成本换算**：用 W9 实测的单价直接算人民币，不写"token 数"了事——
  面试时"我知道每次问答成本 0.003 元"和"我知道 token 数"是两个层次的答案。

## 6. E 组：回归

| 编号 | 动作 | 判定 |
|---|---|---|
| E1 | `npx tsc --noEmit` | 0 错 |
| E2 | `npm run test:unit` | 47/47 仍全绿（日志改造不能改变行为） |
| E3 | `npm run build` | 本地能过；再验 CI 的 build job 也能过 |
| E4 | 手验：故意触发一个错误（临时让某 Server Action throw） | `/admin` 里出现 1 条，连点 3 次 count 变 3 而不是 3 条 |
| E5 | 手验：问一句 → 看 `/admin` 成本块 | 有 1 条记录，token 数与日志一致 |
| E6 | CI：push 一次 | static + build 两个 job 绿，badge 显示 passing |

## 7. 反证清单（本周必须做的破坏性验证）

| 编号 | 破坏方式 | 期望结果 |
|---|---|---|
| R1 | 故意让一条单测失败（断言 `1===2`）后 push | CI **变红**并阻止合并；改回后变绿 |
| R2 | `LOG_LEVEL=error` 启动 | info 日志消失，error 仍在（证明分级非摆设） |
| R3 | 同一错误连触发 3 次 | DB 里 count=3、1 行（证明 fingerprint 合并生效） |
| R4 | 拔掉 `ADMIN_EMAIL` 访问 `/admin` | 404（不是 500、不是空页） |

## 8. 验收清单

- [ ] A1 四个 job 的 yml 落地，`static`+`build` 在 push 时自动跑
- [ ] A2 `npm ci` + 缓存 + PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
- [ ] A4 README 顶部 badge
- [ ] B1 `log.ts` + LOG_LEVEL 生效
- [ ] B2 六处关键路径迁移完成
- [ ] C1 `ErrorLog` 模型 + migration
- [ ] C2 三个上报入口 + 节流
- [ ] C3 `/admin` 受权限保护
- [ ] D1~D3 token/耗时落库 + 成本统计
- [ ] E1~E6 全过
- [ ] R1~R4 反证全过

## 9. 待决事项（需要用户拍板）

### 决策 1：错误监控走自建还是第三方

- ① **自建**（ErrorLog 表 + `/admin`）：零外部账号、零外网依赖；代价是要自己写查看页，功能原始
- ② **Sentry**（`@sentry/nextjs` 免费版）：功能强（聚合/告警/源码映射）；代价是要注册账号、
  引一个较大的依赖、国内网络访问 Sentry 上报端点不稳（W9 已验证海外服务不稳）
- ③ **只打日志不上报**：最省事，但线上报错只有你主动去翻平台日志才能发现

### 决策 2：CI 覆盖范围

- ① **分级**（static+build 每次跑，db/e2e 手动）：稳、快、不会被过期凭证绑架（推荐）
- ② **db 也每次跑**：需要 `DATABASE_URL` secret，且每次 push 都往生产 Neon 写测试数据
- ③ **全量**（含 e2e）：覆盖最全，但 cookie 一过期流水线就红，红的原因与代码无关

## 修订记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-31 | v1 | 初稿 |
| 2026-10-31 | v2 | 拍板：决策①自建错误表、决策②CI 分级（static+build 自动，db/e2e 手动）。实施中两处调整：(a) ErrorLog 不单开 digest 列，digest 追加到 stack 末尾（只为搜索，不值得多一次迁移）；(b) `/admin` 的取数与时间戳移到组件外，满足 React 新的 purity lint 规则。 |
