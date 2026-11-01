/**
 * Agent 路径评测（W10 起，W16 重写为「跑真代码」版）。
 *
 * 用法：
 *   node --experimental-transform-types --import ./scripts/lib/register.mjs scripts/eval-agent.mts --check
 *   …… scripts/eval-agent.mts --probe          多跳题的证据覆盖率探查（不调 LLM，秒级）
 *   …… scripts/eval-agent.mts                  全量：生产 Agent 循环 + 答案层
 *   …… scripts/eval-agent.mts --only=m01,m02   只跑指定用例
 *   …… scripts/eval-agent.mts --verbose        额外打印答案开头
 *
 * ## 为什么这个文件在 W16 被整个重写
 *
 * 旧版（eval-agent.mjs）自己抄了一份检索 SQL，抄的是 W13 之前的 retrieve：
 * 没有 W15 的 rerank、没有 W14 的围栏、没有 suspicious 标记。也就是说它评测的是
 * **一个线上不存在的系统**，且这个偏差持续了两个 W 没人发现 —— 直到它给出的
 * "c19 答不出"被真代码一次跑翻（真代码答对了 29 天）。
 *
 * 新版的做法是彻底不抄：
 *   - 检索：`import { retrieve } from '../src/lib/retrieve.ts'`（真实两段式检索）
 *   - 生成：`import { runAgentTurn } from '../src/lib/agent-llm.ts'`（真实多步循环、真实 prompt、真实编号逻辑）
 * 代价是脚本必须靠 `scripts/lib/register.mjs` 起的解析钩子跑（Node 不认 tsconfig paths 和无后缀导入），
 * 换来的是「评测跑的就是线上那份代码」—— 这条纪律比省事重要得多。
 *
 * 唯一保留的复制品是**统计口径**（位置法 recall），它不是业务逻辑，是度量衡。
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------- 环境：必须在 import 生产模块之前 ----------
function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
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

const ROOT = process.cwd();
const env = loadEnv(path.join(ROOT, '.env.local'));
for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v;
// 评测跑起来时检索日志只会刷屏；降级另有统计口径（见结尾）
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'warn';

// 判据与 eval.mjs 共用同一份（W16：判据本身也是被测对象）
import { describeMiss, matchAnswer } from './lib/answer-match.mjs';

const { runAgentTurn, AGENT_MAX_STEPS } = await import('../src/lib/agent-llm.ts');
const { retrieve, TOP_K, RECALL_K } = await import('../src/lib/retrieve.ts');
const { prisma } = await import('../src/lib/prisma.ts');

// ---------- 参数 ----------
const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const PROBE = args.includes('--probe');
const VERBOSE = args.includes('--verbose');
const KB_NAME = args.includes('--kb') ? args[args.indexOf('--kb') + 1] : '知识库C';
const ONLY = (() => {
  const a = args.find((x) => x.startsWith('--only='));
  return a ? new Set(a.slice('--only='.length).split(',').map((s) => s.trim())) : null;
})();

/**
 * W17 的对照实验开关。
 *
 * 注意默认值的方向：**元数据默认开、指路提示默认关**（W17 的四组对照把提示关掉了，
 * 数据见 eval/meta-results.md）。所以默认跑的这一组就是「A1：有元数据 / 无提示」。
 *
 *   （无参数）         A1  有元数据 / 无提示   ← 线上行为
 *   --no-meta         A0  无元数据 / 无提示
 *   --hint            A3  有元数据 / 有提示
 *   --no-meta --hint  A2  无元数据 / 有提示
 */
const NO_META = args.includes('--no-meta');
const HINT = args.includes('--hint');
if (NO_META) process.env.AGENT_DOC_META = 'off';
if (HINT) process.env.AGENT_POINTER_HINT = 'on';
const ARM = `${NO_META ? '无元数据' : '有元数据'} / ${HINT ? '有提示' : '无提示'}`;

// ---------- 用例类型 ----------
type Evidence = { documentTitle: string; index: number };

type EvalCase = {
  id: string;
  section?: string;
  question: string;
  documentTitle: string;
  expectChunks: { index: number; snippet: string }[];
  answerMustContain?: string[] | null;
  /** W16 新增：组内任一即可（同义表达）。断言型判据的补充，见 scripts/lib/answer-match.mjs */
  answerAnyOf?: string[][] | null;
  /** W16 新增：多跳题的类型。缺省视为单跳。 */
  type?: 'single' | 'bridge' | 'compose' | 'aggregate';
  /** W16 新增：这条题最少需要几次检索才可能答对（单跳题不写） */
  minHops?: number;
  /** W16 新增：证据可能落在哪些块（**可跨文档**） */
  evidence?: Evidence[];
};

const cases = (JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'cases.json'), 'utf8')) as EvalCase[]).filter(
  (c) => !ONLY || ONLY.has(c.id),
);

/**
 * 证据清单。
 * 老用例只有顶层 documentTitle + expectChunks；多跳用例改用 evidence（可跨文档）。
 * 两种写法统一成一种形状，后面的覆盖率计算就不用分叉。
 */
function evidenceOf(c: EvalCase): Evidence[] {
  if (c.evidence?.length) return c.evidence;
  return c.expectChunks.map((e) => ({ documentTitle: c.documentTitle, index: e.index }));
}

const isMultiHop = (c: EvalCase) => Boolean(c.minHops && c.minHops >= 2);

// ---------- 结构校验 ----------
const problems: string[] = [];
{
  const ids = new Set<string>();
  for (const [i, c] of cases.entries()) {
    const where = `第 ${i + 1} 条（${c?.id ?? '无 id'}）`;
    if (!c?.id || typeof c.id !== 'string') problems.push(`${where} 缺 id`);
    else if (ids.has(c.id)) problems.push(`${where} id 重复`);
    else ids.add(c.id);
    if (!c?.question) problems.push(`${where} 缺 question`);
    if (!c?.documentTitle) problems.push(`${where} 缺 documentTitle`);
    if (!Array.isArray(c?.expectChunks) || !c.expectChunks.length) {
      problems.push(`${where} 缺 expectChunks`);
    }
    if (c?.answerMustContain != null && !Array.isArray(c.answerMustContain)) {
      problems.push(`${where} answerMustContain 必须是 null 或数组`);
    }
    // 多跳题的额外纪律
    if (c?.type && c.type !== 'single') {
      if (!c.minHops || c.minHops < 2) problems.push(`${where} type=${c.type} 但 minHops < 2`);
      if (!c.evidence?.length) problems.push(`${where} type=${c.type} 但没有 evidence（无法验证跨块）`);
      const docs = new Set(c.evidence?.map((e) => e.documentTitle));
      if (c.type === 'bridge' && docs.size < 2) {
        problems.push(`${where} bridge 型必须跨至少 2 个文档（当前 ${docs.size} 个）`);
      }
      if (!c.answerMustContain?.length && !c.answerAnyOf?.length) {
        problems.push(`${where} 多跳题必须有 answerMustContain 或 answerAnyOf（否则无法判对错）`);
      }
    }
  }
}

if (problems.length) {
  console.error('评测集有问题：');
  for (const p of problems) console.error(' -', p);
  process.exit(1);
}

const multiCount = cases.filter(isMultiHop).length;
console.log(
  `用例 ${cases.length} 条（多跳 ${multiCount} / 单跳 ${cases.length - multiCount}）  ` +
    `TOP_K=${TOP_K} RECALL_K=${RECALL_K} MAX_STEPS=${AGENT_MAX_STEPS}（全部来自源码）`,
);

if (CHECK_ONLY) {
  console.log('结构 OK');
  await prisma.$disconnect();
  process.exit(0);
}

// ---------- 锁库 + 文档反查 ----------
if (!process.env.DATABASE_URL) {
  console.error('缺少 DATABASE_URL；先确认 .env.local 与代理（127.0.0.1:6864）');
  process.exit(1);
}
const kb = await prisma.knowledgeBase.findFirst({ where: { name: KB_NAME }, select: { id: true } });
if (!kb) {
  console.error(`知识库「${KB_NAME}」不存在；用 --kb 换一个`);
  await prisma.$disconnect();
  process.exit(1);
}

const docCache = new Map<string, string | null>();
async function docIdOf(title: string): Promise<string | null> {
  if (docCache.has(title)) return docCache.get(title) ?? null;
  const d = await prisma.document.findFirst({
    where: { title, kbId: kb!.id },
    select: { id: true },
  });
  docCache.set(title, d?.id ?? null);
  return d?.id ?? null;
}

// ---------- --probe：单跳够不够（不调 LLM） ----------
if (PROBE) {
  const targets = cases.filter(isMultiHop);
  if (!targets.length) {
    console.log('没有多跳用例（type≠single 且 minHops≥2），无需探查');
    await prisma.$disconnect();
    process.exit(0);
  }
  console.log(`\n探查 ${targets.length} 条多跳题：只用原问题检索一次，看证据覆盖率\n`);
  let pass = 0;
  for (const c of targets) {
    const hits = await retrieve(kb.id, c.question);
    const ev = evidenceOf(c);
    // 命中集合用 (documentId, chunkIndex) 判，避免跨文档同名块误判
    const hitSet = new Set<string>();
    for (const h of hits) hitSet.add(`${h.documentId}#${h.chunkIndex}`);
    let covered = 0;
    const missing: string[] = [];
    for (const e of ev) {
      const did = await docIdOf(e.documentTitle);
      if (did && hitSet.has(`${did}#${e.index}`)) covered += 1;
      else missing.push(`${e.documentTitle.slice(0, 12)}#${e.index}`);
    }
    const rate = covered / ev.length;
    // 合格的多跳题：一次检索**拿不全**证据（覆盖率 < 100%）
    const qualified = rate < 1;
    if (qualified) pass += 1;
    console.log(
      `${c.id.padEnd(6)} ${qualified ? '✓真多跳' : '✗一次就够'} 覆盖 ${covered}/${ev.length}` +
        (missing.length ? `  缺 ${missing.join(', ')}` : ''),
    );
  }
  console.log(`\n合格 ${pass}/${targets.length}。不合格的题要么改问法，要么弃用 —— 别拿它当多跳题。`);
  await prisma.$disconnect();
  process.exit(0);
}

// ---------- 全量：跑生产 Agent 循环 ----------
type ArmStat = {
  answerOk: number;
  answerTotal: number;
  retrievals: number;
  tokensIn: number;
  tokensOut: number;
  ms: number;
  msList: number[];
  evidenceRecall: number[]; // 累积引用对 evidence 的覆盖率
  steps: number[];
};

function newStat(): ArmStat {
  return {
    answerOk: 0,
    answerTotal: 0,
    retrievals: 0,
    tokensIn: 0,
    tokensOut: 0,
    ms: 0,
    msList: [],
    evidenceRecall: [],
    steps: [],
  };
}

const byType = new Map<string, ArmStat>();
const overall = newStat();
const regressions: { id: string; missed: string; answer: string }[] = [];

console.log('');
for (const [idx, c] of cases.entries()) {
  const t0 = Date.now();
  let answer = '';
  let retrievals = 0;
  let steps = 1;
  let usage = { inputTokens: 0, outputTokens: 0 };
  const cited: { documentId: string; chunkIndex: number }[] = [];

  try {
    for await (const ev of runAgentTurn({ kbId: kb.id, question: c.question, history: [] })) {
      if (ev.type === 'delta') answer += ev.text;
      else if (ev.type === 'tool') retrievals += 1;
      else if (ev.type === 'citations') {
        for (const ci of ev.citations) cited.push({ documentId: ci.documentId, chunkIndex: ci.chunkIndex });
      } else if (ev.type === 'finish') {
        usage = ev.usage;
        steps = ev.steps;
      }
    }
  } catch (e) {
    console.error(`#${idx + 1} ${c.id} 生成失败：${(e as Error).message}`);
  }

  const ms = Date.now() - t0;
  const key = c.type && c.type !== 'single' ? c.type : 'single';
  const stat = byType.get(key) ?? newStat();
  byType.set(key, stat);

  // 证据覆盖率：累积引用里出现了多少条 evidence
  const ev = evidenceOf(c);
  const citedSet = new Set(cited.map((x) => `${x.documentId}#${x.chunkIndex}`));
  let covered = 0;
  for (const e of ev) {
    const did = await docIdOf(e.documentTitle);
    if (did && citedSet.has(`${did}#${e.index}`)) covered += 1;
  }
  const evRate = covered / ev.length;

  let mark = '-';
  let missText = '';
  const hasCriteria = Boolean(c.answerMustContain?.length || c.answerAnyOf?.length);
  if (hasCriteria) {
    const verdict = matchAnswer(answer, c);
    stat.answerTotal += 1;
    overall.answerTotal += 1;
    if (verdict.ok) {
      stat.answerOk += 1;
      overall.answerOk += 1;
    } else {
      missText = describeMiss(verdict.missed, verdict.failedGroups);
      regressions.push({ id: c.id, missed: missText, answer: answer.slice(0, 160) });
    }
    mark = verdict.ok ? '✓' : '✗';
  }

  for (const s of [stat, overall]) {
    s.retrievals += retrievals;
    s.tokensIn += usage.inputTokens;
    s.tokensOut += usage.outputTokens;
    s.ms += ms;
    s.msList.push(ms);
    s.evidenceRecall.push(evRate);
    s.steps.push(steps);
  }

  console.log(
    `#${String(idx + 1).padStart(2, '0')} ${c.id.padEnd(6)} ${key.padEnd(9)} steps=${steps} ` +
      `检索×${retrievals} 证据=${(evRate * 100).toFixed(0)}% ans=${mark} ` +
      `tok=${usage.inputTokens}/${usage.outputTokens} ${ms}ms`,
  );
  if (VERBOSE && answer) console.log(`      A: ${answer.slice(0, 120).replace(/\n/g, ' ')}`);
}

// ---------- 汇总 ----------
const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const pct = (a: number[], p: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const n = cases.length;

console.log(`\n===== 汇总（${ARM}） =====`);
console.log(
  `答案层 ${overall.answerOk}/${overall.answerTotal}  平均检索 ${(overall.retrievals / n).toFixed(2)} 次/问  ` +
    `平均证据覆盖 ${(avg(overall.evidenceRecall) * 100).toFixed(1)}%`,
);
console.log(
  `token in=${overall.tokensIn}（均 ${Math.round(overall.tokensIn / n)}/问） out=${overall.tokensOut}  ` +
    `耗时 均 ${Math.round(overall.ms / n)}ms  p95 ${Math.round(pct(overall.msList, 0.95))}ms`,
);
console.log('\n按类型：');
for (const [k, s] of [...byType.entries()].sort()) {
  const cnt = cases.filter((c) => (c.type && c.type !== 'single' ? c.type : 'single') === k).length;
  console.log(
    `  ${k.padEnd(10)} n=${String(cnt).padStart(2)}  答案 ${s.answerOk}/${s.answerTotal}  ` +
      `检索 ${(s.retrievals / cnt).toFixed(2)}/问  证据 ${(avg(s.evidenceRecall) * 100).toFixed(0)}%  ` +
      `token ${Math.round(s.tokensIn / cnt)}/问  ${Math.round(s.ms / cnt)}ms`,
  );
}

if (regressions.length) {
  console.log('\n未通过：');
  for (const r of regressions) console.log(`  ✗ ${r.id} ${r.missed} → ${r.answer.replace(/\s+/g, ' ')}`);
}

await prisma.$disconnect();
