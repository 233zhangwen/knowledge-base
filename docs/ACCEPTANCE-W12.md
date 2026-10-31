# W12 验收 spec · 测试基建：Vitest 单测 + Playwright E2E

> 本 spec 由 p 老师执笔（2026-10-30）。方向调整后的第一周：投递暂停，转入工程化。
> 修订记录在文末。

## 背景（三项侦察事实）

1. **仓库零测试框架**。现有 `scripts/verify-*.{mjs,mts}` 共 17 个，全部是「零依赖手工脚本」：
   能跑、能验证、但**不进任何流水线**，靠人记得跑。`package.json` 里没有 `test` 脚本。
2. **改 UI 目前靠人眼**（10-29 那次侧栏 bug 就是这么漏的：`hidden lg:block` 漏写，
   tsc 0 错误、lint 0 错误，问题只在特定宽度下可见）。
3. **改检索靠 `eval-agent.mjs` 全量重跑**（25 条，烧 token 与时间），中间地带
   ——「这个纯函数改对了没有」——没有任何低成本手段。

结论：本周不是"为了覆盖率而测试"，是给后面 W13（CI）、W14（安全）、W15/16（Agent 深挖）
铺一条**改完 30 秒内知道有没有改坏**的路。

## 本周范围（五组）

1. **A 组 · Vitest 接入 + 纯函数单测（主体）**
   - 装 `vitest`，`vitest.config.ts`（`environment: node`，alias `@` → `src`，排除 `e2e/`）。
   - 覆盖对象**只挑有分支、且改坏了不会立刻报错**的纯函数：
     - `chat-protocol.ts`：v1 `feed`/`createCursor` + v2 `feedV2`/`createCursorV2`/`encode*`
       —— 现有 `verify-stream-protocol.mts` 的 23 条用例就是靶子（见 D 组，先决定迁不迁）；
     - `chunk.ts` 的 `splitText`：空串、短于 CHUNK_SIZE、恰好边界、超长无标点、
       overlap 衔接、中文句号/换行边界；
     - `file-types.ts`：`detectSourceType`（大小写、无扩展名、不支持类型）、`buildStorageKey`；
     - `history.ts` 的 `titleFromQuestion`（空、超长、含换行）；
     - `llm.ts` 的 `buildRagMessages`（零引用兜底、历史注入、citation 编号起点）；
     - `conversationTimeParts`：**当前藏在 `page.tsx` 里（未导出）**，抽到
       `src/lib/conversation-time.ts` 再测（今天/昨天/跨年/零点边界/未来时间）。
2. **B 组 · DB 集成测试（小而准，3~5 条）**
   打真实 Neon（`.env.local` 的 DATABASE_URL），只测「隔离与截断」这类纯函数测不到的逻辑：
   - `loadContext` 的历史窗口截断（HISTORY_TURNS 边界）；
   - `listConversations` 的 userId/kbId 双重过滤（别人库的会话查不到）；
   - `resolveConversation` 跨用户拒绝（ConversationNotFound）。
   全部用 `describe.skipIf(!process.env.RUN_DB_TESTS)` 包住，默认不跑；测试自己建
   临时 user/kb/conversation，`afterAll` 清理，不碰既有数据。
3. **C 组 · Playwright E2E（三条核心链路）**
   - 链路 1：上传 `.md` → 等文档 `ready` → 提问 → 断言流式文本出现且含 `[1]` 引用；
   - 链路 2：问一句闲聊 → 断言**不出现**"正在检索"提示（W11 B2 的自动化版本）；
   - 链路 3：新建会话 → 历史侧栏出现该会话 → 删除 → 列表消失。
   - 断言原则：只用 `data-testid` 与文本出现，**禁用 `waitForTimeout`**（流式场景下等死你）。
4. **D 组 · 脚本并轨（方案待定，见"待决事项"）**
   `package.json` 补齐 `test` / `test:unit` / `test:db` / `test:e2e`；`verify:stream` 的归宿。
5. **E 组 · 回归**
   `tsc --noEmit` 0 错误；`npm run lint` 0 错误；`npm run test:unit` 全绿；
   **不跑 eval**（25 条烧 token，本周不动检索逻辑，改动范围不含 `retrieve.ts` / `agent-llm.ts` 的检索分支）。

## 验收标准

### A 组 · 单测

- **A1**：`npm run test:unit` 一条命令跑完，**全部通过且单次 < 10s**（纯函数不该慢）；
- **A2**：`splitText` 至少 6 条用例，含「恰好 CHUNK_SIZE」「超长无标点」两个边界；
- **A3**：`feedV2` 的哨兵用例覆盖：无事件行直接文本 / 文本含 `\n` / 文本含 `\u0000` /
  错误行后不再出文本；
- **A4**：`conversationTimeParts` 已从 `page.tsx` 抽出到 `src/lib/conversation-time.ts`，
  `page.tsx` 改为 import（**行为不变**，页面渲染结果与改动前一致）；
- **A5**：故意改坏一个纯函数（如把 chunk overlap 改 0）→ 对应单测**必须红**，
  恢复后变绿（证明测试真的有牙齿，不是摆设）。

### B 组 · DB 集成

- **B1**：不设 `RUN_DB_TESTS` 时 `npm run test:unit` 不连库、不全红（skip 干净）；
- **B2**：`RUN_DB_TESTS=1 npm run test:db` 全过，且在 Neon 控制台核对：测试结束后
  没有残留的临时 user/kb/conversation 行；
- **B3**：`listConversations` 用例里，用 userA 查 userB 的库 → 结果为空（不是抛错）。

### C 组 · E2E

- **C1**：三条链路全过；**连跑 3 次结果一致**（流式断言不 flaky 是这个组的核心指标）；
- **C2**：`npx playwright test --headed` 能看到真实操作过程（演示可用）；
- **C3**：登录态复用方案落地（见"待决事项"），`e2e/.auth/state.json` **已进 `.gitignore`**；
- **C4**：E2E 失败时产出 trace（`trace: 'on-first-retry'`），`npx playwright show-trace` 能打开。

### D 组 · 脚本并轨

- **D1**：`package.json` 有 `test` / `test:unit` / `test:db` / `test:e2e` 四个脚本，
  语义与上文一致（`test` = unit + e2e，不含 db）；
- **D2**：`verify:stream` 与 vitest 的关系按拍板结果落地，README 的「如何验证」一节同步更新。

### E 组 · 回归

- **E1**：`npx tsc --noEmit` 0 错误；`npm run lint` 0 错误；
- **E2**：手动点一遍：上传 → 提问 → 引用 → 会话切换（确认 A4 的抽取没弄坏页面）。

## 反证（用户执行）

- **R1**：`npm run test:unit` 之外，另建一个空测试文件写 `expect(1).toBe(2)` → 确认
  **红灯真的是红的**、退出码非 0（防止"永远绿的测试"这种最坏情况）；
- **R2**：把 `.env.local` 的 DATABASE_URL 改成一个错端口 → `npm run test:unit` 应当
  **照常全绿**（证明单测真的不碰库）；
- **R3**：E2E 连跑 3 次（C1 的执行者是你，我这边跑不了 dev server）。

## 待决事项（已拍板 2026-10-30）

> 结论：决策 1 选 **①**（storageState 复用），决策 2 选 **③**（共用 cases 数组）。
> 两个都选了倾向方案，理由见下表。

### 决策 1：E2E 怎么过登录这一关 → **① storageState 复用**

| | 方案 | 代价 | 风险 |
|---|---|---|---|
| ① | 手工登录一次，导出 `storageState`（cookie）复用 | 零生产改动；cookie 过期后手工重录一次 | JWT 有效期到了要重录；state 文件是**真凭证**，绝不能进 git |
| ② | 加测试专用 Credentials provider（仅 `E2E_AUTH_BYPASS=1` 时启用） | 生产代码多一条登录路径 | 后门味道；面试被问"你怎么保证它没泄露到生产"要答得清 |
| ③ | E2E 只测未登录可达页面 | 零成本 | 核心链路一条都测不到，等于没做 |

倾向：**①**。理由：E2E 每周只跑几次，cookie 过期重录 1 分钟的代价，远小于在生产
认证配置里留一条后门要长期解释的成本。②留到"多环境测试"真需要时再说。

### 决策 2：`verify-stream-protocol.mts`（23 条）迁进 vitest 还是保留 → **③ 共用 cases**

| | 方案 | 代价 | 风险 |
|---|---|---|---|
| ① | 原样保留脚本，vitest 另写一批（重复） | 两套断言要同步维护 | 漏同步就出现"脚本绿、测试红" |
| ② | 迁进 vitest，`verify:stream` 改指向 `vitest run` | 一套断言 | **失去"零依赖验尸"能力**：以后装不上 node_modules 时，协议验证跑不起来了 |
| ③ | vitest 用例**import 脚本里的 cases 数组**，两边共用同一批数据 | 一套数据、两个 runner | 脚本要小改成导出 cases（约 20 行） |

倾向：**③**。这个仓库两次踩过"npm install 装不上"的坑（见工作日志），
"即使依赖装不上也能验协议"是真实需求，不是洁癖。

## 依赖安装（用户在自己终端执行）

我这边 `npm install` 必失败（历史已知），所以：

```bash
# 1) 先让我改好 package.json 的 devDependencies，再执行
npm install
# 2) Playwright 浏览器（国内建议走镜像，否则下载很慢）
PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npx playwright install chromium
```

新增 devDependencies：`vitest`、`@playwright/test`（`@vitest/coverage-v8` 暂不装，
覆盖率本周不是目标，见自我挑漏洞 1）。

## 自我挑漏洞（写 spec 时自己先戳的）

1. **追求覆盖率会跑偏**：测试的目标不是数字，是"改坏了会不会有人告诉我"。
   所以本 spec **不设覆盖率门槛**，只要求 A5 那条"改坏必须红"的实证。
2. **DB 集成测试打真实 Neon**：跑脏数据、并发污染、代理挂了 CI 全红都是真实风险。
   对策是三件套：`skipIf` 开关 + 专用临时实体 + `afterAll` 清理；代价是清理失败会留垃圾
   （可接受，Neon 免费层定期可手工清）。
3. **E2E 打 dev server 会 flaky**：Next 16 + Turbopack 首次编译慢，流式断言尤其容易踩
   "元素还没挂上就断言"。对策：`data-testid` + 等文本出现 + 全局 timeout 放宽，
   **禁止 waitForTimeout**（它只是把 flaky 变慢，不解决根因）。
4. **storageState 是真凭证**：里面是 `AUTH_SECRET` 加密的会话 JWT，拿到就能冒充你登录。
   必须 `.gitignore`，且本 spec 要求 C3 显式验证这一点。
5. **JS/TS 边界**：vitest 能直接吃 `.ts`，但现有脚本用 `node --experimental-transform-types`
   跑，导入路径带 `.ts` 后缀。共用 cases 时要注意模块解析差异（③ 方案落地时先跑一次两边验证）。

## 实施记录（2026-10-30）

- 两个决策拍板：① storageState + ③ 共用 cases。
- **A 组**：`vitest.config.ts` + `tests/setup-env.ts`（loadEnvFile，不引 dotenv）+ 5 个单测文件
  （protocol / chunk / file-types / history-time / rag-messages）。
  `conversationTimeParts` 已抽到 `src/lib/conversation-time.ts`，page.tsx 改为 import。
- **B 组**：`tests/db/history.test.ts`，6 条，`RUN_DB_TESTS` 开关 + email 前缀清理 + 显式时间戳。
- **C 组**：`playwright.config.ts` + `scripts/save-auth.mjs`（`npm run e2e:auth`）
  + `e2e/kb-flow.spec.ts`（3 条）+ `e2e/fixtures/e2e-sample.md`；
  给 7 处 UI 节点补了 `data-testid`（chat-input/send/stop、message-*、tool-hint、
  citations-summary、file-input、upload-submit、kb-name-input、kb-create-submit、
  kb-link、new-conversation、conversation-link、delete-conversation(-confirm)、doc-status）。
- **D 组**：package.json 增 `test` / `test:unit` / `test:watch` / `test:db` / `test:e2e` / `e2e:auth`；
  `scripts/protocol-cases.mts` 抽出 11 组用例，两个 runner 共用；
  `verify-stream-protocol.mts` 改为薄壳（零依赖能力保留，已实测全过）。
- **写测试时抓到一个真 bug**：`buildRagMessages` 的占位符替换是**链式 replace**
  ——先插入 context、再替换 `{question}`，若文档内容里含字面量 `{question}`，
  被替换掉的是文档里那个（位置更靠前），用户真正的问题反而留在模板里。
  修复：`fill()` 单遍正则替换，替换进去的内容不会被二次扫描。
  连带 `contextItem` / `citationRule` 也改成 fill（同类风险）。
  → 这是"为测试而写测试"立刻回本的案例，也是 W14（AI 安全）的现成素材。
- **未执行（我这边装不了依赖）**：`npm install`、`npm run test:unit`、A5 的"改坏必须红"
  反证、`e2e:auth`、`test:e2e`。R1~R3 全部归用户。

## 修订记录

- 2026-10-30 V1：首版。五组范围 + 两个待决事项。
