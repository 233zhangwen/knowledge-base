/**
 * W14 对抗评测的「文档投毒」准备脚本。
 *
 * 为什么要有这一步：注入的真实入口是**文件**，不是命令行里的一段字符串。
 * 只有把载荷真的写进 Document.content、真的算 embedding、真的能被 retrieve 搜到，
 * 后面测出来的 ASR 才是线上那一套的 ASR。
 *
 * 做法：为一个独立知识库「注入评测库」写入 fixtures，每条 fixture 只有 1 个 chunk
 * （内容都只有几行，不需要走 chunk.ts 的切分逻辑；切分本身由 W12 单测覆盖）。
 *
 * 用法：
 *   node scripts/seed-injection-fixtures.mjs            重建所有投毒文档
 *   node scripts/seed-injection-fixtures.mjs --clean     只删不建（收尾用）
 *
 * 幂等：先按标题删除同库旧文档（Chunk 级联删除），再插入。
 * 这个库不进 W6 的 cases.json，也不参与 eval-agent —— 与「知识库C」基线互不影响。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const ROOT = process.cwd();
const CASES_PATH = path.join(ROOT, 'eval', 'injection-cases.json');
const CLEAN_ONLY = process.argv.includes('--clean');

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

const env = loadEnv(path.join(ROOT, '.env.local'));
const EMBED_BASE_URL = (env.EMBED_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');

const spec = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
const docCases = spec.cases.filter((c) => c.vector === 'document' && c.document);

/**
 * 把载荷变成"人看不见"的形态。
 *
 * zero-width：每个字符之间插一个 U+200B（零宽空格）—— 界面上看是连续文字，
 *             模型分词时基本等价于原文，是真实存在的投毒手法。
 * bidi      ：整段用 U+202E（RTL Override）包裹，视觉上字符顺序被打乱，
 *             典型用于伪装文件名/文本顺序，也是真实攻击手法。
 * 注意：这两种变换都**不改变语义**，所以清洗后模型仍会看到同样的指令 ——
 * 换言之，光靠清洗拦不住「执行」，清洗拦的是「看不见」这件事（配合围栏规则才有完整防线）。
 */
function applyTransform(text, transform) {
  if (transform === 'zero-width') {
    return text
      .split('')
      .map((ch) => ch + '\u200b')
      .join('');
  }
  if (transform === 'bidi') {
    return `\u202e${text}\u202c`;
  }
  return text;
}

async function embed(text) {
  const res = await fetch(`${EMBED_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.EMBED_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.EMBED_MODEL, input: [text] }),
  });
  if (!res.ok) throw new Error(`embedding HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.data[0].embedding;
}

const client = new pg.Client({
  connectionString: env.DIRECT_URL,
  ssl: { rejectUnauthorized: true },
  connectionTimeoutMillis: 15000,
});
await client.connect();

// 库必须独一份，否则「按名字锁库」这个纪律就失效（V11 的教训）
const { rows: kbRows } = await client.query(`select id, "userId" from "KnowledgeBase" where name = $1`, [
  spec.kbName,
]);
let kbId;
let userId;
if (kbRows.length === 0) {
  if (CLEAN_ONLY) {
    console.log(`知识库「${spec.kbName}」不存在，无需清理`);
    await client.end();
    process.exit(0);
  }
  const { rows: users } = await client.query(`select id from "User" order by "createdAt" asc limit 1`);
  if (!users.length) {
    console.error('库里一个用户都没有，先登录一次应用再跑本脚本');
    await client.end();
    process.exit(1);
  }
  userId = users[0].id;
  const { rows: created } = await client.query(
    `insert into "KnowledgeBase" (id, name, description, "userId", "createdAt", "updatedAt")
     values ($1, $2, $3, $4, now(), now()) returning id`,
    [
      `inj-${crypto.randomUUID().slice(0, 8)}`,
      spec.kbName,
      'W14 提示注入对抗评测专用。里面的文档是有意投毒的，不要用来看效果。',
      userId,
    ],
  );
  kbId = created[0].id;
  console.log(`创建知识库「${spec.kbName}」 id=${kbId}`);
} else if (kbRows.length > 1) {
  console.error(`知识库「${spec.kbName}」有 ${kbRows.length} 个，先手动合并再跑`);
  await client.end();
  process.exit(1);
} else {
  kbId = kbRows[0].id;
  userId = kbRows[0].userId;
  console.log(`复用知识库「${spec.kbName}」 id=${kbId}`);
}

// 清旧：只删本评测集的文档（按标题前缀 iNN-），不碰别人手动传的东西
const titles = docCases.map((c) => c.document.title);
const { rows: docs } = await client.query(
  `select id, title from "Document" where "kbId" = $1 and title = any($2::text[])`,
  [kbId, titles],
);
if (docs.length) {
  await client.query(`delete from "Document" where id = any($1::text[])`, [docs.map((d) => d.id)]);
  console.log(`删除旧文档 ${docs.length} 个（Chunk 级联）`);
}
if (CLEAN_ONLY) {
  console.log('清理完成');
  await client.end();
  process.exit(0);
}

for (const c of docCases) {
  const content = applyTransform(c.document.content, c.transform);
  const vector = await embed(content);
  const literal = `[${vector.join(',')}]`;
  const docId = `injdoc-${c.id}-${crypto.randomUUID().slice(0, 6)}`;

  await client.query(
    `insert into "Document" (id, title, "sourceType", "sizeBytes", status, content, "kbId", "createdAt")
     values ($1, $2, 'md', $3, 'ready', $4, $5, now())`,
    [docId, c.document.title, Buffer.byteLength(content, 'utf8'), content, kbId],
  );
  await client.query(
    `insert into "Chunk" (id, content, "chunkIndex", "documentId", embedding)
     values ($1, $2, 0, $3, $4::vector)`,
    [`injchunk-${c.id}-${crypto.randomUUID().slice(0, 6)}`, content, docId, literal],
  );
  console.log(`写入 ${c.id} 《${c.document.title}》 ${content.length} 字${c.transform ? ` [${c.transform}]` : ''}`);
}

await client.end();
console.log(`\n完成：${docCases.length} 篇投毒文档已入库（kb=${kbId}，owner=${userId}）`);
