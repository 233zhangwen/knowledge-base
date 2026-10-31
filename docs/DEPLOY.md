# 部署与运维手册

> 线上地址：https://afei-knowledge-base.netlify.app
> 平台：Netlify（Hobby 免费计划）· 仓库：github.com/233zhangwen/knowledge-base
> 首次部署：2026-10-27

这份文档只写三件事：**以后怎么重新部署一次**、**出问题先看哪里**、**哪些坑已经踩过、为什么长那样**。
每次线上翻车后都往「故障档案」里加一条 —— 它比任何教程都值钱，因为它记录的是这个项目真实踩过的坑。

---

## 一、部署流程（从零或换平台）

### 1. 代码侧前置（已固化在仓库里，通常不用动）

| 位置 | 内容 | 为什么 |
|---|---|---|
| `package.json` 的 `build` | `prisma generate && next build` | `src/generated/prisma` 在 `.gitignore` 里，平台装完依赖没有 client，不先生成必挂 |
| `netlify.toml` | `command = "npm run build"`、`publish = ".next"` | 不写 publish 时 Netlify 默认指向仓库根目录，插件的前置检查会直接拒绝 |
| `netlify.toml` 的 `SECRETS_SCAN_OMIT_KEYS` | 排除 5 个**非机密**键（模型名 / API 端点） | 详见故障档案 F2 |
| `prisma7.config.ts` | 找不到 `.env.local` 时 dotenv 静默跳过 | 平台侧没有 `.env.local`，只有环境变量 |

### 2. 平台配置

1. Netlify 用 GitHub 账号 OAuth 登录（无需手机验证）→ Import 本仓库
2. **Project configuration → Environment variables** 按下表逐项配置
3. **Project configuration → General → Visitor access** 设为 **Public**
   （Netlify 2026-07 起新项目默认私有，否则访客会跳登录页 —— 见 F4）
4. Deploys → Trigger deploy → Deploy site

### 3. 环境变量清单

值全部来自本地 `.env.local`。**`HTTPS_PROXY` 千万不能配**（那是本机翻墙用的，海外机房直连反而会被它坑）。

| Key | 用途 | 备注 |
|---|---|---|
| `DATABASE_URL` | Neon **pooled** 连接串（运行时用） | 必须删掉 Neon 自带的 `&channel_binding=require` |
| `DIRECT_URL` | Neon **direct** 连接串（`prisma generate` / 迁移用） | |
| `AUTH_SECRET` | NextAuth 会话签名 | ⚠️ **上线后永不可改**，一改所有在线用户立刻掉线 |
| `AUTH_GITHUB_ID` | GitHub OAuth Client ID | **缺失时跳转 URL 里会出现 `client_id=undefined`**（F5） |
| `AUTH_GITHUB_SECRET` | GitHub OAuth Client Secret | 标 secret |
| `AUTH_URL` | `https://afei-knowledge-base.netlify.app` | **不配会让登录跳去部署预览域名并 404**（F3） |
| `AUTH_TRUST_HOST` | `true` | 非 Vercel 平台必须 |
| `EMBED_API_KEY` / `EMBED_BASE_URL` / `EMBED_MODEL` | SiliconFlow `BAAI/bge-m3`（1024 维） | |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | DeepSeek | |
| `RERANK_MODEL` | `BAAI/bge-reranker-v2-m3` | 当前代码未使用，预留 |
| `STORAGE_DRIVER` | `db` | **serverless 平台必须**，否则上传报 ENOENT（F6） |
| `NETLIFY_NODE_VERSION` | `22` | 与本地大版本一致；**CI 也用 22**，两边不一致等于没验 |
| `ADMIN_EMAIL` | 你的登录邮箱 | `/admin` 运维页白名单；**不配则该页 404**（不会 403 —— 不暴露"这里有个管理页"） |
| `LOG_LEVEL` | `info`（可选） | 结构化日志级别；排查时临时改 `debug` |
| `LLM_PRICE_IN_PER_M` / `LLM_PRICE_OUT_PER_M` | 元/百万 token（可选） | 配了 `/admin` 才显示金额；不配只显示 token。单价自己按控制台维护，别抄 |

### 4. GitHub OAuth 回调地址

GitHub → Settings → Developer settings → OAuth Apps → 本应用 → **Redirect URIs** 里必须**两条都在**：

```
http://localhost:3000/api/auth/callback/github
https://afei-knowledge-base.netlify.app/api/auth/callback/github
```

换域名 / 换平台时**先加新回调再部署**，否则授权回来必然 `redirect_uri` 不匹配。

### 5. 数据库迁移

迁移在**本地**跑（要 `DIRECT_URL`，且本机代理必须开着）：

```powershell
npx prisma migrate dev --name <迁移名>
npx prisma generate
# 必须验证产物真的更新了（见 F7）
```

平台上**不要**跑迁移：函数是只读文件系统、而且多个实例并发跑迁移很危险。

---

## 二、部署后验收（5 分钟）

```powershell
# ① 健康检查：200 + db up + commit 是刚推的那一版
curl.exe https://afei-knowledge-base.netlify.app/api/health

# ② 鉴权地址对不对：signinUrl/callbackUrl 必须是正式域名，不能是 xxxx--afei-... 预览域
curl.exe https://afei-knowledge-base.netlify.app/api/auth/providers

# ③ 首页应 307 跳 /kb（未登录再跳 /login）
curl.exe -o NUL -w "%{http_code}" https://afei-knowledge-base.netlify.app/
```

然后手点一遍主链路：**GitHub 登录 → 建库 → 传 MD 和 PDF → 等 ready → 提问看流式与引用 → F5 历史还在**。

PDF 样本可用 `scripts/make-fixture-pdf.mjs` 生成（零依赖，改事实点直接重跑）。

---

## 三、监控怎么用（不引入任何付费/自建监控）

| 看什么 | 在哪 | 频率 |
|---|---|---|
| 运行时错误（500 的堆栈） | Netlify → Deploys → 该次部署 → **Functions** 标签 | 出问题时 |
| 构建失败原因 | Deploys → 那次构建 → Deploy log | 每次部署 |
| 站点是否活着 | `GET /api/health`（DB 不通返回 **503**） | 定期 / 报警源 |
| 库用量、连接数 | Neon 控制台 → Project → Monitoring / Usage | 每周 |
| 函数调用量与耗时 | Netlify → 项目 → **Logs & metrics** | 每周 |

约定：**任何报错先看 `/api/health` 的 `commit`**，确认"线上跑的是哪一版"，再谈复现。
用户报错时索要错误页上的「错误编号」（= Next 的 `digest`），能在 Functions 日志里直接定位那一条。

---

## 四、故障档案（都是真踩过的）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| **F1** | 构建失败：`publish directory cannot be the same as the base directory` | 没配 `publish`，Netlify 默认指向仓库根 | `netlify.toml` 写 `publish = ".next"` |
| **F2** | 构建成功后被拦：`Secrets scanning found 5 instance(s)` | 扫描把**环境变量的值**在产物/仓库里反查，命中也算泄密，分不清密钥与公共值（模型名、API 端点被误判） | 先跑 `node scripts/audit-secrets.mjs` 确认真密钥零命中；再把非机密键写进 `SECRETS_SCAN_OMIT_KEYS`。**真密钥永远不许进这个名单** |
| **F3** | 点登录跳到 `xxxx--afei-...netlify.app` 并 404 | 未配 `AUTH_URL`，NextAuth 从请求头推断 base URL，推成了**部署预览域名**（预览域默认私有） | 配 `AUTH_URL` 为正式域名 + 重新部署 |
| **F4** | 部署成功但访问被跳到 `app.netlify.com/edge-access` | Netlify 2026-07 起新项目默认**私有** | General → Visitor access → Public |
| **F5** | GitHub 授权页 `client_id=undefined` | Netlify 上 `AUTH_GITHUB_ID` 缺失/为空（`.env` 文件导入时丢行） | 补该变量 + 重新部署。`redirect_uri` 错→查 `AUTH_URL`；`client_id` 空→查 `AUTH_GITHUB_ID` |
| **F6** | 上传报 `ENOENT: mkdir '/var/task/.storage'` | serverless 函数文件系统**只读**，`storage.ts` 的磁盘驱动不适用 | 配 `STORAGE_DRIVER=db`，原件存 Postgres `ObjectFile` 表 |
| **F7** | 运行时报 `Unknown field X for select statement` | `prisma generate` 静默失败（本机 safe-delete 组件间歇失败），schema 改了但 client 没跟上 | 重跑 generate 并 **grep 产物验证**：`grep -rl <新字段> src/generated/prisma` |
| **F8** | 从域名根访问是 create-next-app 欢迎页 | 根路由从未实现（本地开发一直直接进 `/kb`） | `app/page.tsx` 改 `redirect('/kb')` |

---

## 五、国内访问可达性：实测结论与决定

**实测（2026-10-27，成都 · 手机流量，非 WiFi）**：`*.netlify.app` **慢但能开**，不是被墙。
本机 curl 首屏 TTFB 约 1.0s、`/api/health` 约 2.7s（含 Neon 唤醒），属可接受范围。

**决定：不做国内兜底（不迁 EdgeOne / CloudBase / 反代）。**

理由：
1. 能开就不迁 —— 迁移的成本（重配域名、OAuth 回调、再排一遍 F1~F8）远大于"打开慢两秒"。
2. 作品集的目的是让人看到东西，不是被秒开指标绑架。国内面试官若打开慢，通常也会等。
3. 兜底方案随时可加（Neon 数据 + 原件都在库里，迁平台不用迁数据），**决策可逆就不必现在做**。

**改用低成本补偿**（已做 / 待做）：
- README 顶部写明线上地址，并注明"部署在海外节点，国内访问可能较慢"（待 W8 写）
- 准备 90 秒录屏作为简历附件（待 W8）—— **打不开链接时它就是兜底**

**重新评估的触发条件**（满足任一条就动手）：
- 连续多次实测**打不开**（不只是慢）
- 面试/投递期间收到"链接打不开"的反馈
- 需要演示实时性很强的场景（如现场提问、现场看流式输出）

---

## 六、换回 Vercel 时要做什么

Vercel 注册被 +86 手机验证卡住，暂时搁置；以后要迁回时按这份清单走：

1. 环境变量照上表配（`AUTH_URL` 改成 Vercel 域名、`STORAGE_DRIVER` 保留 `db` 或改用 `BLOB_READ_WRITE_TOKEN`）
2. GitHub OAuth **追加** Vercel 域名回调（别删 Netlify 那条，两边可并存）
3. `netlify.toml` 留着无害（Vercel 不读它）；`build` 脚本已含 `prisma generate`，通用
4. 数据不用迁移：库在 Neon、原件在 Neon 的 `ObjectFile` 表
5. 上线后先打 `/api/health`，再手点登录 + 上传链路
