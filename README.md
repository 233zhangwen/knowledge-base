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
- 单文件 ≤ 10MB，仅 PDF / MD / TXT

**关键设计：原件与问答解耦。** 解析出的文本、切片、向量全在 Postgres，
问答时只读 Postgres、一次都不碰 Blob。所以 Blob 挂了 / 欠费 / 国内访问不通，
**问答功能完全不受影响**，只是不能下载原件；迁移到 R2 也只改上传和下载两处。
这也给 W7 的部署兜底留了退路：真到访问不稳那天，降级掉"下载原件"即可，核心功能照跑。

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
