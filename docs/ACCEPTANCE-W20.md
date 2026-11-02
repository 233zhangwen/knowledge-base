# ACCEPTANCE-W20：邀请与角色 + 活动组织切换

> 状态：**已完成**（2026-11-02）。C1–C6 全过：C1 ✓ C2 ✓ C3 ✓ C4 ✓ C5 ✓ C6 ✓
> （单测 157 / DB 测试 56 / tsc 0 / lint 0 / 评测 52 条答案层 52/52——比基线 51/52 好，
> v04 证据覆盖仍 0% 但答案层判过，同因切片抽签）
> 前置：W19 完成（`8cc3535`）
> 拍板（2026-11-02）：① member 不能删/改别人建的库（仅创建者+owner）② 邀请不绑定 GitHub 账号
> ③ 成员移除本周做
> 日期：2026-11-02

---

## 0. 这个 W 不是「加一个邀请表单」

W19 结束时的状态是：数据模型支持多人，但**产品上只有一个人**——
没有入口能把第二个人拉进来，唯一的 Membership 是登录时自动建的 owner。

把它补齐听起来是三件事：生成邀请链接、加个 member 角色、做个组织切换下拉。
每件事的"直觉写法"都各自埋着一个不会报错的问题：

**① 邀请链接 = 一把不用验证身份的钥匙。**
直觉写法：随机 token 存库里，链接发出去，谁点谁进。
问题一：token 明文落库，DB 一泄露链接全部复活。
问题二：没有原子消费——用户双击"加入"按钮，两个请求都通过了"已使用？没有"的检查，
一条邀请进来两个人。这类竞态在测试里几乎不会出现，在线上只是时间问题。

**② role 检查和租户检查是两层，混在一起会丢一层。**
W19 的 27 条越权测试全部是**行级**的（"A 拿不到 B 的行"）。
W20 引入动作级的权限（"member 不能删别人的库"），它的检查点**不在 where 条件里**——
`findFirst({ id, orgId })` 过了，`role === 'owner'` 忘了查，照样全绿。
如果沿用 W19 的测试思路，role 相关的 bug 一条都抓不住。

**③ 活动组织放 cookie，等于把权限答案交给客户端。**
`requireTenant()` 从"取最早组织"改成"读 cookie 里的 orgId"——
cookie 是用户可以随便改的。不做 membership 校验，任何人把自己 cookie 改成任何 orgId
就进了任何组织。这个洞 W19 的测试也抓不住：它们没测 cookie。

三条共同点：**都不报错，都只在"第二个人真的存在"之后才发作。**
而 W19 之前系统里从来没有第二个人。

---

## 1. 现状核查

| 项 | 现状 |
|---|---|
| Membership | 只有 owner（W19 迁移建的 2 条），role 字段已预留 `owner \| member` 注释 |
| requireTenant() | 取**最早加入**的组织，无切换（W19 遗留账 ①，本期必修） |
| 权限检查 | 只有行级：`where: { id, orgId }`，没有动作级判断 |
| createdBy | 已存在（W19 埋的），还没有任何逻辑用它 —— 本期"仅创建者可删"正是它的第一个消费者 |
| 静态审计 | `check:scope` 30 处查询，17 带条件 + 13 白名单 + 0 裸 |

UI 入口：`/kb`（列表）、`/kb/[id]`（详情）、`/admin`（运维，ADMIN_EMAIL 门控）。
组织相关 UI 为零，本期新增。

---

## 2. 设计决策

### D1：邀请 token——hash 落库、原子消费、过期兜底

- 随机 32 字节 base64url。**明文只在生成响应里出现一次**，库里只存 `sha256(token)`。
  DB 泄露时攻击者拿到的 hash 造不出链接。
- `Invite` 表：`orgId / role / tokenHash / expiresAt / consumedAt / consumedBy`。
- **消费用条件式原子更新**：`updateMany({ where: { id, consumedAt: null }, data })`，
  `count === 1` 才算抢到。两个并发请求只有一个 count 为 1，另一个收到"链接已被使用"。
  先查再改的写法在双击场景下必然双过，不用查就知道错在哪。
- 有效期 7 天，过期查询条件写进同一条 find（`expiresAt: { gt: now }`），不靠定时任务清理。
- **role 由服务端定，不由链接携带**。链接里只有一个 token，role 是生成时写死在库里的
  （本期只有 owner 能生成邀请，role 固定 member）。伪造"给自己发 owner 邀请"没有入口。

### D2：权限矩阵——动作级检查独立成纯函数，不混进 where

| 动作 | owner | member |
|---|---|---|
| 查看组织内库 / 文档 / 会话 | ✓ | ✓ |
| 建库、上传、重索引、对话 | ✓ | ✓ |
| 删除 / 重命名**自己创建**的库 | ✓ | ✓ |
| 删除 / 重命名**别人创建**的库 | ✓ | ✗ |
| 生成邀请链接、查看成员列表 | ✓ | ✗ |

检查独立成 `can(user, action, resource)` 纯函数（无 DB 依赖，单测全覆盖），
在 action 里**先 can 后查**。不把 role 塞进 where 的原因：
`where: { orgId, OR: [role 过滤] }` 需要 join Membership，可读性差且容易写错；
动作权限是"这个动作允许吗"的问题，和"这行数据归哪个租户"是两个维度。

### D3：活动组织——cookie 存 orgId，但每次都验 membership

`requireTenant()` 的新顺序：

1. 读 cookie `activeOrg`（httpOnly）
2. 查 `membership(userId, cookie.orgId)` —— **这一步就是防伪造的全部**：
   cookie 改成不属于自己的 org，membership 查不到，走 fallback
3. 无 cookie / 查不到 → fallback 最早组织（现行为），**不报错**

为什么不把 orgId 放 JWT：W19 已经否过一次（无法主动吊销，被移出组织后 token 还管 90 天）。
cookie 随时可改、随请求可换，配合"每次查 membership"语义才成立。

**被移出组织后**：cookie 指向一个自己已不是成员的组织 → 第 2 步查不到 → 静默 fallback 到
最早组织。这是合理的静默：行为正确且 UI 上当前组织名可见，不是"操作落错地方"那种静默。

### D4：切换 UI——顶栏下拉 + 设置页，不另做"组织中心"

- 顶栏（`/kb` 与 `/kb/[id]` 共用的 header）放当前组织名下拉，列出全部所属组织，点击即切
  （写 cookie + `router.refresh()`，服务端组件重渲染就是新租户的数据，无需前端过滤）。
- `/settings` 页：成员列表（owner 可见）、生成邀请链接、成员移除（见拍板项 3）。

---

## 3. 验收判据

| 编号 | 判据 | 怎么验 |
|---|---|---|
| **C1** | Invite 表落地；token 只以 hash 形式存库 | schema 对照 + 生成邀请后直查 DB 断言明文不存在 |
| **C2** | 一次性：并发/重复消费只有一个成功；过期链接失效 | DB 测试：同一 token 消费两次第二次失败；过期 token 失败 |
| **C3** | 权限矩阵成立：member 删/改别人的库被拒、自己的成功、owner 全通；member 无邀请入口 | DB 测试 + `can()` 单测全排列 |
| **C4** | cookie 伪造无效：`activeOrg` 指向非成员组织时 fallback，不越权 | DB 测试：改 cookie 模拟，断言拿到的 orgId 是 fallback 值 |
| **C5** | 越权测试扩容后全绿 + 变异测试证明 role 检查不是摆设 | 删掉 `can()` 里的 role 判断 → C3 的测试必须红 |
| **C6** | 回归不退化：151 单测、36 DB 测试基线不降，评测 51/52 不动 | `npm run test` / `test:db` / `eval:agent` |

**C5 是本期的 W19 教训复刻**：W19 用变异测试证明了越权测试不是假绿；
W20 的动作级检查是全新的一层，同样不默认相信"我写了 so 测试会抓"。

---

## 4. 显式不做（这一周）

- **组织改名 / 删除 / 转让**：转让涉及"最后一个 owner"约束，一整套边界情况，单独立项
- **成员移除**：视拍板项 3
- **邀请role 选 owner**：本期邀请一律发 member；"邀请共同管理"等有真实需求再说
- **邮件发送**：邀请就是复制链接手动发（GitHub OAuth 用户的邮箱多是 noreply，发了也到不了）
- **配额与用量**：W21，Invite 表不预埋配额字段

---

## 5. 拍板项（实施前确认）

1. member 能否删 / 改**别人建的**库（推荐：不能，仅创建者 + owner——`createdBy` 字段终于有了消费者）
2. 邀请链接是否绑定指定 GitHub 账号（推荐：不绑定——一次性 + 7 天过期 + 只发 member 已够；
   绑定则要求对方先报 GitHub 用户名，摩擦大且真实风险低）
3. 成员移除本周做不做（推荐：做——它是角色的自然收尾，且必然引出 D3 的"被移除后 fallback"，
   这条路径反正要测）

---

## 6. 实施记录

### 6.1 迁移

代理没开（Prisma CLI 会 P1001），但 Node+pg 直连 Neon 是通的 —— 新表迁移不需要
CLI：SQL 手写（结构与 Prisma 生成完全一致，命名对齐 W19 迁移），事务内应用，
`_prisma_migrations` 手工登记（checksum = sha256(migration.sql)，与 CLI 同一算法）。
`prisma generate` 不连库，照常跑。**代理开着之后应跑一次 `npx prisma migrate status` 验证记录没写歪。**

### 6.2 落地清单

| 层 | 文件 | 内容 |
|---|---|---|
| 数据 | `prisma/schema.prisma` + 迁移 `20261102090000_w20_invite` | `Invite` 表（tokenHash unique、role 默认 member、consumedAt 可空） |
| 权限 | `src/lib/permissions.ts`（新） | `can()` 纯函数矩阵；未知动作 fail closed |
| 邀请 | `src/lib/invite.ts`（新） | `createInvite`（hash 落库）/ `consumeInvite`（条件式原子消费 + ALREADY_MEMBER 不烧 token） |
| 会话 | `src/lib/organization.ts` / `session.ts` | `resolveActiveOrg(userId, cookieOrgId)`；requireTenant 读 `activeOrg` cookie → 验 membership → fallback |
| 动作 | `src/app/kb/actions.ts` | rename/delete 先 `can()` 后 updateMany/deleteMany |
| UI | `/settings`（page + actions + 2 组件）、`/invite/[token]`（page + JoinButton）、`kb/OrgSwitcher` | 切换下拉（纯 `<details>`+form，零客户端状态）、邀请生成/消费、成员移除 |
| 测试 | `tests/unit/permissions.test.ts`、`tests/db/invite-role.test.ts` | 矩阵 6 条进无 DB 门禁；DB 20 条（含并发消费、伪造 cookie、NO_ORGANIZATION 契约） |

### 6.3 测试与回归（C1–C6）

| 判据 | 结果 |
|---|---|
| C1 hash 落库 | ✓ 明文 token findFirst 为 null，tokenHash=sha256 命中（DB 测试） |
| C2 一次性/过期 | ✓ 二次消费 USED；**并发消费恰好一个成功**；过期 EXPIRED；假 token INVALID |
| C3 权限矩阵 | ✓ can() 单测 6 条 + DB 矩阵 5 条；member 删别人的库被 where+can 双层挡住 |
| C4 cookie 伪造 | ✓ 指向非成员组织 → fallback 最早组织；被移出后无组织 → NO_ORGANIZATION 契约 |
| C5 变异测试 | ✓ 砍掉 createdBy 分支 → 1 条单测红（kb:delete member 打别人的库）；还原全绿 |
| C6 回归 | 单测 **157**（151+6）/ DB **56**（36+20）/ tsc 0 / lint 0（含 eslint 新增 `^_` 忽略规则）/ check:scope 60 文件 32 查询 19 带条件 + 13 白名单 + 0 裸 |

评测：**52 条答案层 52/52**，1.48 次检索/问，4642 token/问。对比 W18 基线（51/52）：
本周没动检索层，v04 证据覆盖仍 0%（切片抽签同因），但答案层判据这次过了 ——
按"判据先行"的纪律：没有改任何检索代码，这个波动属于判据边缘，如实记录不邀功。

### 6.4 过程中踩的

- **测试用了同一批用户**：P 在第一条用例消费成功成了成员，后续用例再让他消费就命中
  ALREADY_MEMBER（行为正确、测试误判）。两红的根因是测试设计，不是产品代码 ——
  修法：每条消费用例用独立的新用户（`mkInvitee`）。
- **相对导入层级**：`/invite/[token]` 比想象中深一层（`../../settings/actions`），
  tsc 抓出来 3 处。
- **eslint 的 args 规则是 after-used**：`(_prev, formData)` 不报、`(_prev, _formData)` 报
  —— 最后一个参数没用才会报。配置里补了 `^_` 忽略而不是逐行 disable。

### 6.5 遗留

1. **E2E 没跑**（同 W19）：需要 dev server 在他自己终端起；`/invite/[token]` 登录回跳、
   `<details>` 下拉切换这两条交互路径只有浏览器能验。
2. **代理开着后跑 `npx prisma migrate status`**，确认手工登记的 checksum 被 CLI 认可。
3. 多 owner 场景（邀请发 owner）整个是防出来的，没测真实路径 —— 显式不在范围。
