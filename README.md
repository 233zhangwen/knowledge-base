# knowledge-base

个人知识库问答（RAG）应用。上传文档 → 切片向量化 → 基于检索的问答，回答带引用溯源。

技术栈：Next.js（App Router）+ TypeScript + Tailwind + NextAuth v5 + Prisma + PostgreSQL(pgvector) + Vercel AI SDK。

完整 README（含架构图、评测方法、部署说明）在 W8 收尾时写。下面先记录**真实踩过的决策**，这部分比代码更能说明问题。

## 技术决策记录（ADR）

### 1. session 策略用 jwt，不用 database
`proxy.ts`（Next 16 起 middleware 改叫 proxy）跑在 Edge Runtime，**没有 Prisma**。
database 策略下 cookie 里放的是 Session 表的随机 token，读 session 必须查库 —— proxy 做不到，
于是它会按默认的 jwt 逻辑去解密那串随机字符串，报 `JWEInvalid: Invalid Compact JWE`，
把所有已登录用户判成未登录并弹回登录页。

选 jwt 后：cookie 本身就是 `AUTH_SECRET` 加密的会话，proxy 本地解密即可，零数据库依赖。
代价：**服务端无法主动吊销某个设备的会话**（MVP 接受）。
副作用：adapter 仍会写 `User` / `Account` 表，但 `Session` 表永远为空。

### 2. NextAuth 配置必须拆成两份（split config）
- `src/auth.config.ts`：Edge 安全，只有 providers / pages / session.strategy / authorized 回调，**不 import Prisma**
- `src/auth.ts`：展开上面那份 + `PrismaAdapter`（跑在 Node Runtime）

坑：合并时 `callbacks` 必须写 `...authConfig.callbacks` 再追加 ——
对象展开遇到同名 key 是**覆盖不是合并**，漏了这行 `authorized` 就没了。
当前 proxy 用的是独立实例所以不会立刻出问题，但一旦有人把 proxy 改成从 `@/auth` 导入，
路由保护就**静默失效**（不报错、不告警，谁都能进受保护页面）。

### 3. AI provider 走 OpenAI 兼容抽象，可切换
无海外账号，用国内服务：Embedding 用 SiliconFlow `BAAI/bge-m3`（**1024 维**），LLM 用 DeepSeek。
代码层统一用 OpenAI 兼容 SDK 指向各自 baseURL，保留切换能力。
> `deepseek-flash` 是推理模型，默认会把 token 烧在思考上。RAG 问答默认传 `thinking: { type: 'disabled' }`。

### 4. Prisma 7 的连接地址不在 schema 里
Prisma 7 起 `schema.prisma` 不再支持 `url` / `directUrl`，改到根目录 `prisma7.config.ts`。
该 config **没有 `directUrl` 字段**，所以分两处：迁移用 `DIRECT_URL`（直连），运行时用 `DATABASE_URL`（连接池）。

### 5. 本地开发需要给 Node 挂代理
浏览器走系统代理，但 **Node 的内置 fetch 不认 Windows 系统代理**，
导致服务端拿 code 换 access_token 时直连 github.com 超时（`UND_ERR_CONNECT_TIMEOUT`）。
解法：由外层进程设 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY` 再启动 next dev
（**必须在进程启动前设**，运行时改 `process.env` 无效）。已封装成 `npm run dev`。
生产环境（Vercel）无此变量，包装器自动直连。

### 6. 上传的原件存 Vercel Blob，且与问答链路解耦
先问清楚"留着原件是为了什么"：只有三个用途 —— 重新切片（W6 换了切片策略要重跑）、
用户下载/预览、引用溯源。而**引用溯源其实不需要原件**（切片文本已在 `Chunk` 表里）。

排除的两个错误答案：
- **服务器本地磁盘**：Vercel 是 serverless，`/tmp` 临时、冷启动清空、不跨实例共享。
  本地开发一切正常，上线后随机丢文件。
- **存进 Postgres（bytea）**：Neon 免费层存储额度小，几十个 PDF 就撑爆；
  二进制列还会拖慢查询和备份。

选 **Vercel Blob** 的理由很实际：和部署平台同一家，一个 `BLOB_READ_WRITE_TOKEN` + `@vercel/blob` 就够，
MVP 阶段"少一个移动部件"比"省几块钱"重要。
备选 Cloudflare R2（10GB 免费、egress 免费、S3 兼容），代价是多一个账号 + aws-sdk，**等真被额度卡住再迁**。

落地约定：
- 服务端 Server Action 里上传，不走浏览器直传 —— 才能在同一个地方校验大小 / MIME / userId
- key 命名 `${userId}/${documentId}-${原文件名}`，天然做用户隔离
- 仅 PDF / MD / TXT
- **单文件上限 4MB**（`src/lib/file-types.ts` 的 `MAX_FILE_SIZE` 是唯一来源）

> ⚠️ **修正：这一条原来写的是 10MB，那是我拍的，经不起检验。**
> Vercel Serverless 的**请求体硬上限是 4.5MB**，超过之后 Server Action 连被调用的机会都没有；
> 而且 Next 的 Server Action 默认 `bodySizeLimit` 只有 1MB，必须在 `next.config.ts` 显式放开。
> 现在是三层配合：应用层拦 4MB（`file-types.ts`）→ Next 放行到 5MB（留 1MB 给 multipart 开销）
> → 平台上限 4.5MB（不可配置）。要突破只能改成浏览器直传签名 URL，那是 W7 的事。
>
> 这条记录的价值不在"数字从 10 变成 4"，而在演示一个动作：
> **文档里每个拍出来的数字都必须能被验证、能被推翻。** 无法验证的数字等于没有依据。

本地开发没有 Vercel Blob，所以 `src/lib/storage.ts` 做了一层 driver 抽象：
有 `BLOB_READ_WRITE_TOKEN` 走 Blob，否则写仓库根的 `.storage/`（已 gitignore）。
业务代码只认 `put / remove` 两个动作 —— 这也让"换云厂商"不再是散落各处的改动。

**PDF 解析选 unpdf（pdfjs 的轻量封装），且刻意用了动态 import。**

`unpdf@1.9.1` 零运行时依赖（自带 bundled pdfjs），不需要额外配 canvas / worker，
能在 Vercel 的 Node runtime 里直接跑。但它的 pdfjs bundle 有 **1.5MB** ——
所以 `src/lib/parse.ts` 里是 `await import('unpdf')` 而不是顶层 import：
传一个 1KB 的 .md 不该把 1.5MB 的 pdfjs 也加载进内存。

实测（`next build` 产物）确认这个隔离真的生效了，pdfjs 落在独立 chunk 里：

```
server/chunks/ssr/node_modules_unpdf_dist_pdfjs_mjs_*.js   1561 KB   ← 懒加载
server/chunks/ssr/node_modules_unpdf_dist_index_mjs_*.js      2 KB   ← 入口
```

代价要提前记下：这 1.5MB 会计入 **Vercel Serverless Function 的体积上限**
（免费层 250MB 解压后），RAG 主包变大后可能成为约束。真到那一步的处理方向是
把解析拆成独立 Route Handler 或走浏览器端解析，都属于"等真卡住再动"。

**关键设计：原件与问答解耦。** 解析出的文本、切片、向量全在 Postgres，
问答时只读 Postgres、一次都不碰 Blob。所以 Blob 挂了 / 欠费 / 国内访问不通，
**问答功能完全不受影响**，只是不能下载原件；迁移到 R2 也只改上传和下载两处。
这也给 W7 的部署兜底留了退路：真到访问不稳那天，降级掉"下载原件"即可，核心功能照跑。

### 7. 对话历史：存快照、不存外键；分段上下文而非全量

三条各自独立的选择，放在一起是因为它们回答的是同一个问题：
**"三个月后回头看这条历史，它还成立吗？"**

**① 引用存快照（`Message.citations` 含片段全文），不存 `chunkId` 外键。**

W4 已经拒绝过一次"前端二次查库"（拿到的会是**当前**库里的 chunk）。
历史里若只存外键，用户翻旧对话点开引用，看到的是重排过的、甚至早已不存在的切片 ——
**同一个 bug，只是被推迟了三个月发作。**
存快照的代价是每条 assistant 消息多几 KB JSON，可以忽略。

必须接受的副作用（**是特性不是 bug**）：重建索引或删除文档之后，
历史回答里的引用仍然显示当时的原文 —— 它忠实记录了"这个答案是依据当时那份文档得出的"。

**② 上下文只带最近 3 轮（6 条消息），且不带历史消息自己的 citations。**

一轮问答不到 1000 token，3 轮约 3000，加上 system 和 5 个片段约 1800，合计 5k 上下。
DeepSeek 窗口远没到上限，**瓶颈不是窗口而是注意力稀释** —— 塞 20 条进去，
真正有用的那条反而被淹没（和 TOP_K 选 5 是同一个判断）。
历史不带自己的引用：一条回答的 5 个片段约 2500 字，带上等于把上下文翻一倍，
而那些旧检索结果跟当前问题大概率无关 —— 花双倍的钱买来噪声。

`3` 是**可调常量**，不是架构决定：追问经常被截断就改成 5。

**③ 会话分组代替分页，侧栏只列最近 20 个。**

会话本身就是天然的数据边界（一次会话很少超过 30 条消息），
用它做分组就已经解决了"数据量无限增长"，不需要再套一层滚动分页。
会话标题取首问前 20 字，**不调 LLM 生成摘要** —— 为一个导航锚点花一次调用不值，
还会给首轮增加延迟。

**三条配套的实现约定：**

- **会话 id 搭流的第一行回到前端**（`{"citations":[...],"conversationId":"..."}`）。
  会话是"第一次提问时"才创建的（进页面不创建，否则侧栏很快被空会话刷屏），
  而响应已经是流了 —— 再开一个接口问 id 就多一次往返，还存在
  "答案正在生成、前端却拿着旧会话"的窗口。
- **「停止生成」落库并标记为 `stopped`；「生成失败」不落库。**
  这两个必须分开实现：用户是自己按停的，半截内容留着比"白等一场"更符合直觉；
  而失败时留下一条写着"生成失败"的假回答，会在 W6 评测时被当成样本污染数据。
  所以失败路径留下的那条"没有答案的 user 消息"，由 UI 侧推断出未完成状态并提示可重问。
- **切换会话时靠卸载重挂载**（`key={conversationId}`）清空本地状态。
  `useState` / `useActionState` 都没有 reset API，这是唯一可靠的重置方式。

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
