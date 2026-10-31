/**
 * W15 的 A/B 评测：纯向量 top5 vs 向量 topN → rerank → top5。
 *
 * 与 eval.mjs 的分工：
 *   eval.mjs        验"检索对不对"，口径固定 K=5，W6 起的历史基线都在它那儿；
 *   eval-rerank.mts 验"rerank 值不值"，只跑三档对照，输出一张对比表。
 *
 * 三档同一进程内跑完，而且**共用同一份问题向量** ——
 * 否则三次 embedding 的浮点尾数差异会混进结果，把 0.01 量级的变化搅浑。
 *
 * 用法（必须用 transform-types，因为要 import 真实的 rerank.ts）：
 *   node --experimental-transform-types scripts/eval-rerank.mts
 *   node --experimental-transform-types scripts/eval-rerank.mts --only=v01,n01
 *   node --experimental-transform-types scripts/eval-rerank.mts --kb=知识库C
 *
 * 输出走 stdout（可直接贴进 eval/rerank-results.md），耗时走 stderr。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

// 评测跑起来时日志只会刷屏，降级情况最后统一统计
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'error';

const ROOT = process.cwd();

/**
 * 复用生产的 rerank 实现，而不是在脚本里再写一遍。
 *
 * 为什么需要 materialize：项目里的模块写的是 `from './log'`（无扩展名，
 * Next 的 bundler 能解析），而 Node 的 ESM 要求相对路径带扩展名。
 * 这里把用到的模块复制到 .seed-tmp/ 并给相对 import 补上 .ts 后缀，
 * **业务逻辑一个字不动**。tsconfig 已开 allowImportingTsExtensions，
 * 所以这种写法在 tsc 那边也合法。
 *
 * 替代方案"在脚本里重写一遍 rerank 逻辑"是绝对不行的：
 * 那测的就不是线上那份代码了，绿了也没有意义。
 */
function materialize(relPaths: string[]): string {
  const dir = path.join(ROOT, '.seed-tmp');
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of relPaths) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const patched = src.replace(/from '(\.\/[^']+)'/g, (whole, p) =>
      p.endsWith('.ts') ? whole : `from '${p}.ts'`,
    );
    fs.writeFileSync(path.join(dir, path.basename(rel)), patched);
  }
  return pathToFileURL(path.join(dir, 'rerank.ts')).href;
}

const { rerankChunks } = await import(materialize(['src/lib/log.ts', 'src/lib/rerank.ts']));

const argv = process.argv.slice(2);
const kbArg = argv.find((a) => a.startsWith('--kb='));
const KB_NAME = kbArg ? kbArg.slice('--kb='.length) : '知识库C';
const onlyArg = argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',')) : null;

/**
 * 四档。
 *   5   = "不接 rerank"的现状
 *   10  = 压缩候选池，用来验证"延迟能不能压回预算内、代价是掉多少收益"
 *   20  = 决策①定的拟上线配置
 *   50  = 找饱和点（当前库只有 40 块，50 实际等于全库）
 */
const ARMS = [
  { key: 'V5', recall: 5, rerank: false },
  { key: 'R10', recall: 10, rerank: true },
  { key: 'R20', recall: 20, rerank: true },
  { key: 'R50', recall: 50, rerank: true },
];

const TOP_K = 5; // 与 src/lib/retrieve.ts 的 TOP_K 保持一致（这里写死是有意的：本脚本只做对照，不跟线上参数联动）

/** eval/cases.json 的一条用例。 */
type EvalCase = {
  id: string;
  section?: string;
  question: string;
  documentTitle: string;
  expectChunks: { index: number; snippet: string }[];
  confuserChunks?: { documentTitle: string; index: number; snippet: string; note?: string }[];
  answerMustContain?: string[] | null;
};

/** 一条检索命中。rerank 只需要 id + content，其余字段用于指标计算。 */
type Hit = {
  id: string;
  content: string;
  chunkIndex: number;
  documentId: string;
  documentTitle: string;
  similarity: number;
};

function loadEnv(file: string): Record<string, string> {
  const raw = fs.readFileSync(file, 'utf8');
  const out: Record<string, string> = {};
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

const envPath = path.join(ROOT, '.env.local');
if (fs.existsSync(envPath)) {
  for (const [k, v] of Object.entries(loadEnv(envPath))) {
    if (!(k in process.env)) process.env[k] = v;
  }
}

const EMBED_BASE_URL = (process.env.EMBED_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');

/**
 * 答案层（--with-llm）。
 *
 * 为什么非做不可：W6 那次调优的教训是**指标全绿但答案变差**。
 * 检索指标只衡量"正确块有没有进前 K"，不衡量"模型有没有据此答对"。
 * rerank 会把一些题的正确块往上提、把另一些往下压（本 W 实测降了 7 条），
 * 所以必须看答案层才知道净效果。
 *
 * 只跑 V5 和 R10 两档：它们是决策的两个候选，R20/R50 的 hits 与 R10 高度重合，
 * 再跑 90 次 LLM 只是多花钱买同样的结论。
 */
const WITH_LLM = argv.includes('--with-llm');
const LLM_ARMS = new Set(['V5', 'R10']);

const prompt = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lib', 'rag-prompt.json'), 'utf8'));

function buildMessages(question: string, chunks: Hit[]) {
  const context = chunks.length
    ? chunks
        .map((c, i) =>
          prompt.contextItem
            .replace('{no}', () => String(i + 1))
            .replace('{title}', () => c.documentTitle ?? '')
            .replace('{page}', () => String(c.chunkIndex + 1))
            .replace('{content}', () => c.content),
        )
        .join('\n\n')
    : prompt.contextEmpty;

  const rules = [
    ...prompt.system.rules,
    chunks.length
      ? prompt.system.citationRule.replace('{max}', () => String(chunks.length))
      : prompt.system.noContextRule,
  ];
  const systemContent = [prompt.system.intro, ...rules.map((r, i) => `${i + 1}. ${r}`)].join('\n');

  return [
    { role: 'system', content: systemContent },
    {
      role: 'user',
      content: prompt.userPrefix
        .replace('{context}', () => context)
        .replace('{question}', () => question),
    },
  ];
}

async function askLlm(question: string, chunks: Hit[]): Promise<string> {
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.LLM_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL,
      stream: false,
      messages: buildMessages(question, chunks),
      temperature: prompt.sampling.temperature,
      // 与线上 llm.ts 同一开关（见 memory：enable_thinking 无效，只有这个有效）
      thinking: { type: 'disabled' },
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
}

async function embedOne(text: string): Promise<number[]> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(`${EMBED_BASE_URL}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.EMBED_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: process.env.EMBED_MODEL, input: [text] }),
      });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
        continue;
      }
      if (!res.ok) throw new Error(`embedding HTTP ${res.status}`);
      const json = await res.json();
      return json.data[0].embedding;
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  throw new Error('embedding 重试耗尽');
}

const cases = (JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'cases.json'), 'utf8')) as EvalCase[]).filter(
  (c) => !ONLY || ONLY.has(c.id),
);

const client = new pg.Client({
  connectionString: process.env.DIRECT_URL,
  ssl: { rejectUnauthorized: true },
  connectionTimeoutMillis: 15000,
});
await client.connect();

const { rows: kbs } = await client.query(`select id from "KnowledgeBase" where name = $1`, [KB_NAME]);
if (kbs.length !== 1) throw new Error(`知识库「${KB_NAME}」匹配到 ${kbs.length} 个`);
const KB_ID = kbs[0].id;

// ---------- 文档索引 ----------
async function docIdOf(title: string): Promise<string> {
  const { rows } = await client.query(
    `select id from "Document" where title = $1 and "kbId" = $2`,
    [title, KB_ID],
  );
  if (rows.length !== 1) throw new Error(`文档「${title}」在「${KB_NAME}」里匹配到 ${rows.length} 个`);
  return rows[0].id;
}

// ---------- 粗排 ----------
async function search(vectorLiteral: string, limit: number): Promise<Hit[]> {
  const { rows } = await client.query(
    `select c.id, c.content, c."chunkIndex", d.id as "documentId", d.title as "documentTitle",
            1 - (c.embedding <=> $1::vector) as similarity
       from "Chunk" c
       join "Document" d on d.id = c."documentId"
      where d."kbId" = $2 and d.status = 'ready'
      order by c.embedding <=> $1::vector asc, c."chunkIndex" asc
      limit $3`,
    [vectorLiteral, KB_ID, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    chunkIndex: r.chunkIndex,
    documentId: r.documentId,
    documentTitle: r.documentTitle,
    similarity: Number(r.similarity),
  }));
}

// ---------- 指标 ----------
/** recall@k：前 k 位里命中了几个 gold 块 / gold 块总数。与 eval.mjs 同口径。 */
function recallAt(hits: Hit[], goldDocId: string, expect: number[], k: number): number {
  const hit = new Set();
  for (const h of hits.slice(0, k)) {
    if (h.documentId === goldDocId && expect.includes(h.chunkIndex)) hit.add(h.chunkIndex);
  }
  return hit.size / expect.length;
}

/** MRR：第一个 gold 块位置的倒数。@1 只看第一名，MRR 能看到"从第 3 提到第 2"。 */
function reciprocalRank(hits: Hit[], goldDocId: string, expect: number[]): number {
  for (let i = 0; i < hits.length; i += 1) {
    const h = hits[i];
    if (h.documentId === goldDocId && expect.includes(h.chunkIndex)) return 1 / (i + 1);
  }
  return 0;
}

function firstGoldPos(hits: Hit[], goldDocId: string, expect: number[]): number {
  return hits.findIndex((h) => h.documentId === goldDocId && expect.includes(h.chunkIndex));
}

function firstConfuserPos(hits: Hit[], confusers: { docId: string; index: number }[]): number {
  return hits.findIndex((h) =>
    confusers.some((c) => c.docId === h.documentId && c.index === h.chunkIndex),
  );
}

const percentile = (arr: number[], p: number): number => {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

// ---------- 主循环 ----------
const confuserDocCache = new Map();
async function confuserDocId(title: string): Promise<string> {
  if (!confuserDocCache.has(title)) confuserDocCache.set(title, await docIdOf(title));
  return confuserDocCache.get(title);
}

/** 一组（一档）跑出来的全部统计。显式写出来是必要的：Object.fromEntries 会把它推断成 never[]。 */
type ArmStat = {
  r1: number[];
  r3: number[];
  r5: number[];
  mrr: number[];
  confuserTop5: number[];
  confuserAbove: number[];
  ms: { total: number; rerank: number; embed: number }[];
  perCase: { id: string; rr: number; degraded: boolean }[];
  answers: { id: string; ok: boolean; missed: string[]; answer: string }[];
};

const results: Record<string, ArmStat> = Object.fromEntries(
  ARMS.map((a) => [
    a.key,
    {
      r1: [],
      r3: [],
      r5: [],
      mrr: [],
      confuserTop5: [],
      confuserAbove: [],
      ms: [],
      perCase: [],
      answers: [],
    } satisfies ArmStat,
  ]),
);
let rerankDegraded = 0;
let rerankCalls = 0;
const missDetail = [];

for (const c of cases) {
  const goldDocId = await docIdOf(c.documentTitle);
  const expect = c.expectChunks.map((e) => e.index);

  const confusers = [];
  for (const cc of c.confuserChunks ?? []) {
    confusers.push({ docId: await confuserDocId(cc.documentTitle), index: cc.index });
  }

  const t0 = Date.now();
  const vector = await embedOne(c.question);
  const embedMs = Date.now() - t0;
  const literal = `[${vector.join(',')}]`;

  for (const arm of ARMS) {
    const ta = Date.now();
    let hits = await search(literal, arm.recall);
    let degraded = false;

    if (arm.rerank) {
      rerankCalls += 1;
      const tR = Date.now();
      const out = await rerankChunks(c.question, hits, TOP_K);
      degraded = out.degraded;
      if (degraded) rerankDegraded += 1;
      // rerank 输出的 item 仍带 similarity / chunkIndex / documentId，直接用
      hits = out.items;
      results[arm.key].ms.push({ total: Date.now() - ta, rerank: Date.now() - tR, embed: embedMs });
    } else {
      hits = hits.slice(0, TOP_K);
      results[arm.key].ms.push({ total: Date.now() - ta, rerank: 0, embed: embedMs });
    }

    const r = results[arm.key];
    const rr = reciprocalRank(hits, goldDocId, expect);
    r.r1.push(recallAt(hits, goldDocId, expect, 1));
    r.r3.push(recallAt(hits, goldDocId, expect, 3));
    r.r5.push(recallAt(hits, goldDocId, expect, 5));
    r.mrr.push(rr);
    r.perCase.push({ id: c.id, rr, degraded });

    if (confusers.length) {
      const gp = firstGoldPos(hits, goldDocId, expect);
      const cp = firstConfuserPos(hits, confusers);
      r.confuserTop5.push(cp >= 0 ? 1 : 0);
      r.confuserAbove.push(cp >= 0 && (gp < 0 || cp < gp) ? 1 : 0);
    }

    if (arm.key === 'V5' && reciprocalRank(hits, goldDocId, expect) === 0) {
      missDetail.push({ id: c.id, top: hits.map((h) => `${h.documentId.slice(-4)}#${h.chunkIndex}`) });
    }

    /**
     * 答案层：用这一档最终的 5 条做上下文，让模型照线上 prompt 回答，
     * 再检查 answerMustContain 里的关键词有没有出现。
     * 这不是"模型好不好"的评测 —— 是"检索给的料有没有让模型答对"的评测。
     */
    if (WITH_LLM && LLM_ARMS.has(arm.key) && Array.isArray(c.answerMustContain)) {
      const answer = await askLlm(c.question, hits.slice(0, TOP_K));
      const missed = (c.answerMustContain as string[]).filter((m) => !answer.includes(m));
      r.answers.push({ id: c.id, ok: missed.length === 0, missed, answer: answer.slice(0, 160) });
    }
  }

  process.stderr.write(`[${c.id}]`);
}
process.stderr.write('\n');

const avg = (a: number[]): number => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const fmt = (x: number, d = 3): string => x.toFixed(d);

console.log(`\n## rerank A/B 对照 · ${KB_NAME} · ${cases.length} cases\n`);
console.log('| 组 | recall@1 | recall@3 | recall@5 | MRR@5 | 负例进 top5 | 负例压过正例 | 粗排 p50 | 精排 p50 | 合计 p95 |');
console.log('|---|---|---|---|---|---|---|---|---|---|');

for (const arm of ARMS) {
  const r = results[arm.key];
  const total = r.ms.map((m) => m.total);
  const bare = r.ms.map((m) => m.total - m.rerank);
  const rr = r.ms.map((m) => m.rerank);
  console.log(
    `| ${arm.key}（候选 ${arm.recall}） | ${fmt(avg(r.r1))} | ${fmt(avg(r.r3))} | ${fmt(avg(r.r5))} | ${fmt(avg(r.mrr))} | ` +
      `${r.confuserTop5.length ? fmt(avg(r.confuserTop5)) : '—'} | ` +
      `${r.confuserAbove.length ? fmt(avg(r.confuserAbove)) : '—'} | ` +
      `${percentile(bare, 50)}ms | ${percentile(rr, 50)}ms | ${percentile(total, 95)}ms |`,
  );
}

console.log(`\nrerank 调用 ${rerankCalls} 次，降级 ${rerankDegraded} 次`);
if (rerankDegraded) {
  console.error('⚠️ 有降级发生，这轮数字不可用于上线决策');
}

// ---------- 相对 V5 的净变化（判据就落在这两行上） ----------
const baseP95 = percentile(results.V5.ms.map((m) => m.total), 95);
const baseMrr = avg(results.V5.mrr);
console.log('\n### 相对 V5 的净变化\n');
console.log('| 组 | ΔMRR@5 | Δp95 | 判据① MRR≥+0.03 | 判据② p95≤+400ms |');
console.log('|---|---|---|---|---|');
for (const arm of ARMS.slice(1)) {
  const r = results[arm.key];
  const p95 = percentile(r.ms.map((m) => m.total), 95);
  const dMrr = avg(r.mrr) - baseMrr;
  const dP95 = p95 - baseP95;
  console.log(
    `| ${arm.key} | ${dMrr >= 0 ? '+' : ''}${fmt(dMrr)} | ${dP95 >= 0 ? '+' : ''}${dP95}ms | ` +
      `${dMrr >= 0.03 ? '✅' : '❌'} | ${dP95 <= 400 ? '✅' : '❌'} |`,
  );
}

// ---------- 逐条升降（W6 的教训：总指标涨了不代表每条都涨） ----------
const v5Map = new Map(results.V5.perCase.map((x) => [x.id, x.rr]));
console.log('\n### 逐条升降（V5 → R20）\n');
for (const arm of ARMS.slice(1)) {
  const up = [];
  const down = [];
  for (const c of results[arm.key].perCase) {
    const b = v5Map.get(c.id) ?? 0;
    if (c.rr > b) up.push(`${c.id}(+${fmt(c.rr - b, 2)})`);
    else if (c.rr < b) down.push(`${c.id}(${fmt(c.rr - b, 2)})`);
  }
  console.log(`- ${arm.key}：升 ${up.length} 条${up.length ? ' — ' + up.join(' ') : ''}`);
  console.log(`- ${arm.key}：降 ${down.length} 条${down.length ? ' — ' + down.join(' ') : ''}`);
}


if (WITH_LLM) {
  console.log('\n### 答案层（answerMustContain 关键词命中）\n');
  for (const arm of ARMS.filter((a) => LLM_ARMS.has(a.key))) {
    const ans = results[arm.key].answers;
    const pass = ans.filter((a) => a.ok).length;
    console.log(`- **${arm.key}**：${pass}/${ans.length} 通过`);
    for (const a of ans.filter((x) => !x.ok)) {
      console.log(
        `  - ✗ ${a.id} 缺「${a.missed.join(' / ')}」→ ${a.answer.replace(/\s+/g, ' ').slice(0, 90)}`,
      );
    }
  }
}

if (missDetail.length) {
  console.log(`\nV5 完全未召回的 case（${missDetail.length} 条）：`);
  for (const m of missDetail) console.log(`  ${m.id}: top5 = ${m.top.join(' ')}`);
}

await client.end();
