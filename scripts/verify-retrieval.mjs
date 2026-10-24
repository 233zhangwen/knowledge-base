/**
 * B4 的完整版：真·语义检索冒烟。
 *
 * 前面 db-query.mjs 的【6】只能证明"相邻块在向量空间里确实相近"（自检索），
 * 这一步证明的是更硬的东西：**一句查询文本，能命中内容相关的 chunk**。
 * 这就是 W4 RAG 检索那一环的雏形 —— 现在用脚本验通，W4 出问题时
 * 你就知道该怀疑的是 Prompt 和生成，而不是检索。
 *
 * 用法：
 *   node scripts/verify-retrieval.mjs "你的问题"
 *
 * 例（如果传的是技术文档）：
 *   node scripts/verify-retrieval.mjs "怎么配置环境变量"
 *
 * 判绿：top1 的片段内容确实回答/相关你问的那句话。无关 = 检索有问题。
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

function loadEnv(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    let v = t.slice(i + 1).trim();
    const q = v[0];
    if (q === '"' || q === "'") {
      const end = v.indexOf(q, 1);
      v = end === -1 ? v.slice(1) : v.slice(1, end);
    } else {
      const hash = v.indexOf(' #');
      if (hash !== -1) v = v.slice(0, hash).trim();
    }
    out[t.slice(0, i).trim()] = v;
  }
  return out;
}

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.error('用法：node scripts/verify-retrieval.mjs "你的问题"');
  console.error('例：node scripts/verify-retrieval.mjs "文档里怎么配置环境变量"');
  process.exit(1);
}

const env = loadEnv(path.resolve(process.cwd(), '.env.local'));
const { EMBED_API_KEY, EMBED_MODEL } = env;
const EMBED_BASE_URL = (env.EMBED_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');

if (!EMBED_API_KEY || !EMBED_MODEL) {
  console.error('❌ 缺少 EMBED_API_KEY / EMBED_MODEL');
  process.exit(1);
}

// ---------- ① 把查询句变成向量 ----------
console.log(`查询句：「${query}」`);
console.log(`模型：${EMBED_MODEL}\n`);

const t0 = Date.now();
const res = await fetch(`${EMBED_BASE_URL}/embeddings`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${EMBED_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: EMBED_MODEL, input: [query] }),
});

if (!res.ok) {
  console.error(`❌ embedding 服务返回 HTTP ${res.status}：${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}

const json = await res.json();
const vector = json.data?.[0]?.embedding;

if (!Array.isArray(vector) || vector.length !== 1024) {
  console.error(`❌ 向量维度不对：期望 1024，实际 ${vector?.length ?? 'undefined'}`);
  process.exit(1);
}
console.log(`✅ 查询向量化完成（1024 维，${Date.now() - t0}ms）\n`);

// ---------- ② 去库里找最近的 5 块 ----------
const client = new pg.Client({
  connectionString: env.DIRECT_URL,
  ssl: { rejectUnauthorized: true },
  connectionTimeoutMillis: 15000,
});
await client.connect();

const { rows } = await client.query(
  `select d.title,
          c."chunkIndex",
          1 - (c.embedding <=> $1::vector) as sim,
          left(c.content, 80) as preview
   from "Chunk" c join "Document" d on d.id = c."documentId"
   order by c.embedding <=> $1::vector
   limit 5`,
  [`[${vector.join(',')}]`]
);

await client.end();

if (!rows.length) {
  console.log('❌ 库里一条 chunk 都没有 —— 先去页面上传文档。');
  process.exit(1);
}

console.log('最相关的 5 个片段：\n');
rows.forEach((r, i) => {
  console.log(`#${i + 1}  sim=${Number(r.sim).toFixed(4)}  ${r.title} · 第 ${r.chunkIndex} 块`);
  console.log(`    ${String(r.preview).replace(/\s+/g, ' ')}`);
});

console.log(
  `\n判绿：#1 的片段内容和你问的话确实相关（哪怕只是话题相关）。`,
);
console.log(`若 #1 都驴唇不对马嘴 —— 检索环节有问题，W4 之前必须查清。`);
