/**
 * W4 端到端冒烟：**不走浏览器**跑一遍真实的「检索 → 拼 Prompt → 流式生成 → 前端解析」。
 *
 * 为什么要写它：spec 里最难判的两条是 A3（无依据时要说"文档里没有"）和
 * B4（不许用常识纠正文档）。这两条问的是**模型行为**，不是代码行为，
 * 光看代码永远不知道答案 —— 必须真的问一次。而且将来 W6 调 Prompt / 换模型，
 * 这个脚本就是回归基线。
 *
 * 跑法：
 *   node --experimental-strip-types scripts/verify-rag-e2e.mts "你的问题"
 *   node --experimental-strip-types scripts/verify-rag-e2e.mts "你的问题" <kbId>
 *
 * 关于"复刻"：检索那段 SQL 是复制的（为了绕开 Node 直接 import 带 @/ 别名的
 * prisma.ts）。它是 retrieve.ts 里那段 SQL 的镜像，改了那边必须同步改这里 ——
 * 所以 SQL 上方写了对照注释。其余全是真文件：embedding / llm / chat-protocol。
 */
import { readFileSync } from 'node:fs';

import pg from 'pg';

import { embedTexts } from '../src/lib/embedding.ts';
import { buildRagMessages, streamChat } from '../src/lib/llm.ts';
import {
  createCursor,
  encodeHeadLine,
  feed,
  type Citation,
} from '../src/lib/chat-protocol.ts';

const TOP_K = 5;

function loadEnv() {
  try {
    const raw = readFileSync('.env.local', 'utf8');
    for (const line of raw.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      let value = m[2].trim();
      if (value.startsWith('"') || value.startsWith("'")) {
        const quote = value[0];
        const end = value.indexOf(quote, 1);
        value = end === -1 ? value.slice(1) : value.slice(1, end);
      }
      process.env[m[1]] = value;
    }
  } catch {
    console.error('读不到 .env.local');
    process.exit(1);
  }
}

loadEnv();

const question = process.argv[2];
if (!question) {
  console.error('用法：node --experimental-strip-types scripts/verify-rag-e2e.mts "问题" [kbId]');
  process.exit(1);
}
const kbIdArg = process.argv[3];

const client = new pg.Client({
  connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

async function main() {
  await client.connect();

  // kbId 没给就挑 chunk 最多的知识库（和 db-query.mjs【6】同一个选择逻辑）
  const kbId =
    kbIdArg ??
    (
      await client.query(
        `select d."kbId"
         from "Chunk" c join "Document" d on d.id = c."documentId"
         where d.status = 'ready'
         group by d."kbId" order by count(*) desc limit 1`,
      )
    ).rows[0]?.kbId;

  if (!kbId) {
    console.error('库里没有任何 ready 文档的 chunk，先上传并索引一个文档');
    process.exit(1);
  }

  // ① 检索（真 embedding + 与 retrieve.ts 同一段 SQL）
  const [vector] = await embedTexts([question]);
  const literal = `[${vector.join(',')}]`;
  const { rows } = await client.query(
    `-- 与 src/lib/retrieve.ts 保持一致：kbId 过滤 + status='ready' + <=> 余弦距离
     select c.id, c.content, c."chunkIndex", d.id as "documentId", d.title,
            1 - (c.embedding <=> $1::vector) as similarity
     from "Chunk" c
     join "Document" d on d.id = c."documentId"
     where d."kbId" = $2 and d.status = 'ready'
     order by c.embedding <=> $1::vector
     limit ${TOP_K}`,
    [literal, kbId],
  );

  const chunks = rows.map((r) => ({
    id: r.id,
    chunkIndex: r.chunkIndex,
    documentId: r.documentId,
    documentTitle: r.title,
    similarity: Number(r.similarity),
    content: r.content,
    suspicious: false,
  }));

  console.log(`知识库 ${kbId}\n问题：${question}\n`);
  console.log(`【检索】召回 ${chunks.length} 条`);
  for (const [i, c] of chunks.entries()) {
    console.log(`  [${i + 1}] ${c.documentTitle} 第${c.chunkIndex + 1}段 sim=${c.similarity.toFixed(4)}`);
  }

  const citations: Citation[] = chunks;

  // ② 生成（真 llm.ts）
  const t0 = Date.now();
  let firstTokenAt = 0;
  let text = '';
  let stream = encodeHeadLine({ citations, conversationId: null }); // ③ 顺手用真协议包一遍流
  for await (const delta of streamChat(buildRagMessages(question, chunks))) {
    if (!firstTokenAt) firstTokenAt = Date.now() - t0;
    text += delta;
    stream += delta;
    process.stdout.write(delta);
  }

  console.log(
    `\n\n【生成】首字 ${firstTokenAt}ms / 总耗时 ${Date.now() - t0}ms / ${text.length} 字`,
  );

  // ④ 让真解析器读一遍这整条流，验证"前端视角"拿到的是什么
  const cursor = createCursor();
  feed(cursor, stream);
  console.log(
    `【协议解析】citations=${cursor.citations.length} answer=${cursor.answer.length} 字 ` +
      `一致=${cursor.answer === text && cursor.citations.length === citations.length}`,
  );

  // ⑤ 引用编号检查（spec B2）：模型引用的编号必须落在本次召回范围内
  const used = [...new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))].sort(
    (a, b) => a - b,
  );
  const outOfRange = used.filter((n) => n < 1 || n > citations.length);
  console.log(`【引用检查】答案里出现的编号 ${JSON.stringify(used)}`);
  console.log(
    outOfRange.length === 0
      ? `✅ 全部落在 [1..${citations.length}] 内，没有幻觉引用`
      : `❌ 越界编号 ${JSON.stringify(outOfRange)} —— 模型编造了引用`,
  );

  await client.end();
}

main().catch(async (e) => {
  console.error('\n失败：', e instanceof Error ? e.message : e);
  await client.end().catch(() => {});
  process.exit(1);
});
