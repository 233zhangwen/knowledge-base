/**
 * W10 Agent 路径评测脚本（对应 docs/ACCEPTANCE-W10.md C 组）。
 *
 * 用法：
 *   node scripts/eval-agent.mjs --check     只校验评测集结构（不调 API，秒级）
 *   node scripts/eval-agent.mjs             跑全量：Agent 路径的检索 recall + 答案
 *   node scripts/eval-agent.mjs --verbose   额外打印每条的答案开头
 *
 * 与 eval.mjs 的关系：cases.json / kb 反查 / 位置法 recall / 排序口径完全同一套；
 * 差别只有两点 ——
 *   ① 检索不再每次必跑，而是包在 retrieve_knowledge 工具里由模型决定调不调
 *      （C3 的"闲聊零 embedding"就来自这个差别）；
 *   ② 生成走 AI SDK 多步循环（与线上 agent-llm.ts 同构），prompt 同读 agent-prompt.json。
 *
 * 口径声明（spec 自我挑漏洞 3）：本脚本走库内调用，测"生成质量"层；
 * 协议/路由层由 A/B 组用 curl 实测，两层各测各的。
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { generateText, stepCountIs, tool, jsonSchema } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

const ROOT = process.cwd();
const CASES_PATH = path.join(ROOT, 'eval', 'cases.json');
const PROMPT_PATH = path.join(ROOT, 'src', 'lib', 'agent-prompt.json');
const AGENT_LLM_PATH = path.join(ROOT, 'src', 'lib', 'agent-llm.ts');

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const VERBOSE = args.includes('--verbose');

/**
 * 库范围（2026-10-28 新增）：生产冒烟把同一份手册传进了另一个知识库，
 * "按标题找文档"从此可能匹配多个 —— spec V11 的"恰好 1 个"检查因此全体 SKIP。
 * 解法是先锁库再找文档：默认 知识库C（W6 基线评测所在库），可用 --kb 覆盖。
 * 这样 cases.json 一字不用动，确定性反而更强（多库同名不再是隐患）。
 */
const KB_NAME = args.includes('--kb') ? args[args.indexOf('--kb') + 1] : '知识库C';

/** Agent 多步上限：与 agent-llm.ts 的 AGENT_MAX_STEPS 必须同源（V10 的教训：别写死）。 */
function readMaxSteps() {
  const source = fs.readFileSync(AGENT_LLM_PATH, 'utf8');
  const m = source.match(/export const AGENT_MAX_STEPS = (\d+)/);
  if (!m) throw new Error('读不到 agent-llm.ts 里的 AGENT_MAX_STEPS');
  return Number(m[1]);
}
const MAX_STEPS = readMaxSteps();

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
const LLM_BASE_URL = (env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');

const cases = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
const prompt = JSON.parse(fs.readFileSync(PROMPT_PATH, 'utf8'));

// ---------- 结构校验（不连库） ----------
const problems = [];
{
  const ids = new Set();
  cases.forEach((c, i) => {
    const where = `第 ${i + 1} 条（${c?.id ?? '无 id'}）`;
    if (!c?.id || typeof c.id !== 'string') problems.push(`${where} 缺 id`);
    else if (ids.has(c.id)) problems.push(`${where} id 重复`);
    else ids.add(c.id);
    if (!c?.question) problems.push(`${where} 缺 question`);
    if (!c?.documentTitle) problems.push(`${where} 缺 documentTitle`);
    if (!Array.isArray(c?.expectChunks) || !c.expectChunks.length) {
      problems.push(`${where} 缺 expectChunks`);
    } else {
      for (const [j, e] of c.expectChunks.entries()) {
        if (!Number.isInteger(e?.index) || e.index < 0) {
          problems.push(`${where} expectChunks[${j}].index 不是非负整数`);
        }
        if (!e?.snippet || String(e.snippet).trim().length < 4) {
          problems.push(`${where} expectChunks[${j}].snippet 缺失或过短`);
        }
      }
    }
    if (c?.answerMustContain != null && !Array.isArray(c.answerMustContain)) {
      problems.push(`${where} answerMustContain 必须是 null 或数组`);
    }
  });
}
if (problems.length) {
  console.error('评测集有问题：');
  for (const p of problems) console.error(' -', p);
  process.exit(1);
}
if (CHECK_ONLY) {
  console.log(
    `评测集 OK：${cases.length} 条，MAX_STEPS=${MAX_STEPS}（来源 agent-llm.ts），temperature=${prompt.sampling.temperature}（来源 agent-prompt.json）`,
  );
  process.exit(0);
}

// ---------- 真实检索（与线上 retrieve.ts 同一 SQL 口径，含二级排序） ----------
const client = new pg.Client({
  connectionString: env.DIRECT_URL,
  ssl: { rejectUnauthorized: true },
  connectionTimeoutMillis: 15000,
});
await client.connect();

// 锁库：必须在跑之前就失败，不能跑到一半才发现库不存在
const kbName = KB_NAME;
const { rows: kbRows } = await client.query(`select id from "KnowledgeBase" where name = $1`, [kbName]);
if (kbRows.length !== 1) {
  console.error(`知识库「${kbName}」匹配 ${kbRows.length} 个（必须恰好 1 个）；可用 --kb <名称> 指定`);
  await client.end();
  process.exit(1);
}
const KB_ID = kbRows[0].id;

const K = 5; // 与 retrieve.ts 的 TOP_K 同值；改它同样会让历史基线作废

async function embedQuestion(text) {
  const res = await fetch(`${EMBED_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.EMBED_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.EMBED_MODEL, input: [text] }),
  });
  if (!res.ok) throw new Error(`embedding HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.data[0].embedding;
}

async function searchChunks(kbId, question) {
  const vector = await embedQuestion(question);
  const literal = `[${vector.join(',')}]`;
  const { rows } = await client.query(
    `select c.id, c.content, c."chunkIndex", d.id as "documentId", d.title,
            1 - (c.embedding <=> $1::vector) as similarity
     from "Chunk" c join "Document" d on d.id = c."documentId"
     where d."kbId" = $2 and d.status = 'ready'
     order by c.embedding <=> $1::vector asc, c."chunkIndex" asc
     limit $3`,
    [literal, kbId, K],
  );
  return rows.map((r) => ({ ...r, similarity: Number(r.similarity) }));
}

// ---------- Agent 路径（与 agent-llm.ts 同构：AI SDK + 全局编号工具） ----------
const injectThinking = async (url, init) => {
  const body = JSON.parse(String(init.body));
  body.thinking = { type: 'disabled' };
  return fetch(url, { ...init, body: JSON.stringify(body) });
};
const deepseek = createOpenAI({
  baseURL: LLM_BASE_URL,
  apiKey: env.LLM_API_KEY,
  name: 'deepseek',
  fetch: injectThinking,
});
const llm = deepseek(env.LLM_MODEL);

const systemContent = [
  prompt.system.intro,
  ...prompt.system.rules.map((r, i) => `${i + 1}. ${r}`),
].join('\n');

console.log(`K=${K}  MAX_STEPS=${MAX_STEPS}（来源 agent-llm.ts）  temperature=${prompt.sampling.temperature}`);
console.log(`库：${kbName}（--kb 可换）  评测 ${cases.length} 条（Agent 路径）…\n`);

const stats = {
  recallSum: { 1: 0, 3: 0, 5: 0 },
  answerOk: 0,
  answerCases: 0,
  retrieveCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
};

for (const [idx, c] of cases.entries()) {
  const t0 = Date.now();

  // 文档反查：标题 + 已锁的 kbId（V11 的多库同名解法，见文件头 KB_NAME 说明）
  const { rows: docs } = await client.query(
    `select id, "kbId" from "Document" where title = $1 and "kbId" = $2`,
    [c.documentTitle, KB_ID],
  );
  if (docs.length !== 1) {
    console.log(`#${String(idx + 1).padStart(2, '0')} SKIP：文档「${c.documentTitle}」匹配 ${docs.length} 个`);
    continue;
  }
  const doc = docs[0];

  const ledger = { numbers: new Map(), citations: [] };
  let retrieveCalls = 0;

  const retrieveTool = tool({
    description:
      '从用户上传的文档知识库中检索与问题相关的原文片段。凡是可能和文档内容有关的问题（制度、流程、数字、条款），都必须先调用本工具，不要凭记忆回答。',
    inputSchema: jsonSchema({
      type: 'object',
      properties: { question: { type: 'string', description: '改写后的独立、完整的检索问句' } },
      required: ['question'],
    }),
    execute: async ({ question }) => {
      retrieveCalls += 1;
      const chunks = await searchChunks(doc.kbId, question);
      if (!chunks.length) return prompt.toolEmptyResult;
      return chunks
        .map((ch) => {
          let no = ledger.numbers.get(ch.id);
          if (no === undefined) {
            no = ledger.numbers.size + 1;
            ledger.numbers.set(ch.id, no);
            ledger.citations.push(ch);
          }
          return `[${no}] （来自文档《${ch.title}》第 ${ch.chunkIndex + 1} 段）\n${ch.content}`;
        })
        .join('\n\n');
    },
  });

  let answer = '';
  let usage = { inputTokens: 0, outputTokens: 0 };
  let steps = 1;
  try {
    const res = await generateText({
      model: llm,
      temperature: prompt.sampling.temperature,
      system: systemContent,
      prompt: c.question,
      tools: { retrieve_knowledge: retrieveTool },
      stopWhen: stepCountIs(MAX_STEPS),
    });
    answer = res.text;
    usage = {
      inputTokens: res.totalUsage?.inputTokens ?? 0,
      outputTokens: res.totalUsage?.outputTokens ?? 0,
    };
    steps = res.steps?.length ?? 1;
  } catch (e) {
    console.error(`#${idx + 1} 生成失败：${e.message}`);
  }

  // 位置法 recall（与 eval.mjs 同款）：只认目标文档的期望块在**累积引用序列**里的位置
  const position = new Map();
  ledger.citations.forEach((h, pos) => {
    if (h.documentId === doc.id && !position.has(h.chunkIndex)) {
      position.set(h.chunkIndex, pos);
    }
  });
  const expect = c.expectChunks.map((e) => e.index);
  const recallAt = (k) =>
    expect.filter((i) => (position.get(i) ?? Infinity) < k).length / expect.length;

  const r1 = recallAt(1);
  const r3 = recallAt(3);
  const r5 = recallAt(5);
  stats.recallSum[1] += r1;
  stats.recallSum[3] += r3;
  stats.recallSum[5] += r5;

  let answerMark = '-';
  if (Array.isArray(c.answerMustContain) && c.answerMustContain.length) {
    stats.answerCases += 1;
    const ok = c.answerMustContain.every((kw) => answer.includes(kw));
    if (ok) stats.answerOk += 1;
    answerMark = ok ? '✓' : '✗';
  }

  stats.retrieveCalls += retrieveCalls;
  stats.tokensIn += usage.inputTokens;
  stats.tokensOut += usage.outputTokens;

  console.log(
    `#${String(idx + 1).padStart(2, '0')} steps=${steps} 检索×${retrieveCalls} ` +
      `r@1=${r1.toFixed(2)} r@3=${r3.toFixed(2)} r@5=${r5.toFixed(2)} ans=${answerMark} ` +
      `tok=${usage.inputTokens}/${usage.outputTokens} ${Date.now() - t0}ms`,
  );
  if (VERBOSE && answer) {
    console.log(`   A: ${answer.slice(0, 110).replace(/\n/g, ' ')}`);
  }
}

await client.end();

const n = cases.length;
console.log('\n===== Agent 路径汇总 =====');
console.log(
  `recall@1=${(stats.recallSum[1] / n).toFixed(3)} ` +
    `@3=${(stats.recallSum[3] / n).toFixed(3)} @5=${(stats.recallSum[5] / n).toFixed(3)}`,
);
console.log(`答案层：${stats.answerOk}/${stats.answerCases}（有 answerMustContain 的 ${stats.answerCases} 条）`);
console.log(
  `总检索次数：${stats.retrieveCalls}（${n} 问 → 平均 ${(stats.retrieveCalls / n).toFixed(2)} 次/问）`,
);
console.log(`总 token：in=${stats.tokensIn} out=${stats.tokensOut}`);
