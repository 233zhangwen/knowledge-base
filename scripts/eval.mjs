/**
 * W6 检索评测脚本（对应 docs/ACCEPTANCE-W6.md）。
 *
 * 三档用法：
 *   node scripts/eval.mjs --check      只校验评测集（不调 embedding，秒级）
 *   node scripts/eval.mjs             跑全量检索评测，打印 recall@5
 *   node scripts/eval.mjs --with-llm   额外调 LLM 生成答案，供人工对照关键词
 *
 * 设计要点（每条都对应 spec 里的一处修订，别"顺手优化"掉）：
 *
 * ① 检索范围是**整个知识库**（kbId 级，与线上 retrieve.ts 一致），不是单文档。
 *    只在目标文档内检索会高估 recall —— 少了其他文档的竞争。
 *
 * ② `order by ... asc, "chunkIndex" asc` 的二级排序不是可选项（B2 ② / V4）：
 *    相似度完全并列时 pgvector 不保证返回顺序，没有 tie-breaker 时
 *    连跑两次结果就可能不同，B3 会偶发假红。
 *
 * ③ stdout 里**不能出现耗时/时间戳**（B1）：B3 要靠两次输出逐字节 diff。
 *    耗时一律走 stderr。
 *
 * ④ K 不写死在脚本里当真理：--check 会去 retrieve.ts 读 `TOP_K = N` 比对（V10）。
 *    原写法只靠一行注释提醒"改 TOP_K 要同步改"，属于纪律冒充机制。
 *
 * ⑤ prompt 从 rag-prompt.json 读（与 llm.ts 同一份）：
 *    否则评测跑的不是线上 prompt，C4-b 的"改 prompt 前后对比"没有意义。
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const ROOT = process.cwd();
const CASES_PATH = path.join(ROOT, 'eval', 'cases.json');
const PROMPT_PATH = path.join(ROOT, 'src', 'lib', 'rag-prompt.json');
const RETRIEVE_PATH = path.join(ROOT, 'src', 'lib', 'retrieve.ts');

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const WITH_LLM = args.includes('--with-llm');
/**
 * 相似度默认不打印（B3 实测后改的，见 spec 修订 V12）：
 * embedding 是远程服务，同一句问题两次返回的向量浮点尾数会差最后几位
 * （实测 0.593 / 0.594），于是"连跑两次逐字节一致"偶发假红。
 * 确定性真正成立的地方是**排序结果**（chunkIndex 整数序列），不是相似度小数。
 * 需要看小数时加 --verbose。
 */
const VERBOSE = args.includes('--verbose');

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

// ---------- 读入配置 ----------
const cases = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
const prompt = JSON.parse(fs.readFileSync(PROMPT_PATH, 'utf8'));

/** K 必须与线上 retrieve.ts 同源（B2 ③ / V10）。读不到就报错，不猜默认值。 */
function readTopK() {
  const source = fs.readFileSync(RETRIEVE_PATH, 'utf8');
  const m = source.match(/export const TOP_K\s*=\s*(\d+)/);
  if (!m) throw new Error('读不到 src/lib/retrieve.ts 里的 `export const TOP_K = N`');
  return Number(m[1]);
}

const K = readTopK();

/**
 * 评测固定看到多深（≥5），**独立于线上 K**。
 *
 * 这是个口径问题，不是优化：第一版直接 `limit: K`，于是一旦把线上 TOP_K 改成 3，
 * 召回就只剩 3 条，`@5` 自动退化成 `@3` —— 三指标不再可比，
 * C2 的"改前/改后"看起来会像**口径变了**而不是参数变了，归因直接失效。
 * 固定取 max(5, K) 条后：@1/@3/@5 始终是同一把尺子的刻度，
 * 而线上实际只用前 K 条 —— 所以调小 K 时，"@5 高、@3 低"正说明召回变窄了。
 */
const DEEP = Math.max(5, K);

const errors = [];
function error(msg) {
  errors.push(msg);
  console.error(`ERROR ${msg}`);
}

// ---------- 校验（--check） ----------
async function runCheck(client) {
  if (!Array.isArray(cases)) throw new Error('eval/cases.json 顶层必须是数组');
  if (!cases.length) throw new Error('eval/cases.json 是空的');

  const ids = new Set();
  let nullAnswerCases = 0;

  for (const [i, c] of cases.entries()) {
    const where = `第 ${i + 1} 条（${c?.id ?? '无 id'}）`;

    if (!c || typeof c !== 'object') {
      error(`${where} 不是对象`);
      continue;
    }
    if (!c.id || typeof c.id !== 'string') error(`${where} 缺 id`);
    else if (ids.has(c.id)) error(`${where} id 重复：${c.id}`);
    else ids.add(c.id);

    if (!c.question || typeof c.question !== 'string' || !c.question.trim()) {
      error(`${where} 缺 question`);
    }
    if (!Array.isArray(c.expectChunks) || !c.expectChunks.length) {
      error(`${where} 缺 expectChunks（或为空）`);
      continue;
    }
    for (const [j, e] of c.expectChunks.entries()) {
      if (!Number.isInteger(e?.index) || e.index < 0) {
        error(`${where} 的 expectChunks[${j}].index 不是非负整数`);
      }
      if (!e?.snippet || String(e.snippet).trim().length < 4) {
        error(`${where} 的 expectChunks[${j}].snippet 缺失或过短（<4 字，不足以当指纹）`);
      }
    }
    if (c.answerMustContain === null || c.answerMustContain === undefined) {
      nullAnswerCases += 1;
    } else if (!Array.isArray(c.answerMustContain) || !c.answerMustContain.length) {
      error(`${where} 的 answerMustContain 必须是 null 或非空数组`);
    }

    // 文档定位：必须恰好 1 个（V11：同名文档会取错）
    const { rows: docs } = await client.query(
      `select id, "kbId" from "Document" where title = $1`,
      [c.documentTitle],
    );
    if (docs.length !== 1) {
      error(`${where} 的 documentTitle「${c.documentTitle}」匹配到 ${docs.length} 个文档（必须恰好 1 个）`);
      continue;
    }
    if (!c.documentTitle) error(`${where} 缺 documentTitle`);

    const doc = docs[0];
    const { rows: chunks } = await client.query(
      `select "chunkIndex", "content" from "Chunk" where "documentId" = $1 order by "chunkIndex"`,
      [doc.id],
    );

    for (const e of c.expectChunks) {
      if (!Number.isInteger(e?.index)) continue;
      const target = chunks.find((x) => x.chunkIndex === e.index);
      if (!target) {
        // 越界（V2 的一半）：切片变少时能发现
        error(
          `${where} 的 expectChunks index=${e.index} 越界：该文档只有 ${chunks.length} 块（0~${chunks.length - 1}）`,
        );
        continue;
      }
      // 漂移（V2 的另一半）：切片数不变、但边界移动时，只有指纹能发现
      const head = String(target.content).trimStart();
      if (e.snippet && !head.startsWith(String(e.snippet).trimStart())) {
        error(
          `${where} 标注已过期：chunk ${e.index} 开头是「${head.slice(0, 16)}」，期望「${e.snippet}」`,
        );
      }
    }
  }

  // 纯检索 case（answerMustContain=null）允许存在，但不许超过 1/3（V8）
  if (nullAnswerCases > Math.floor(cases.length / 3)) {
    error(
      `answerMustContain 为 null 的 case 有 ${nullAnswerCases} 条，超过总数 ${cases.length} 的 1/3 —— 答案层被放弃得太多`,
    );
  }

  /**
   * K 的来源必须被"看见"，而不是被"检查"（V10 的二次修订）。
   *
   * 第一版这里写的是"读 retrieve.ts 的 TOP_K，与脚本的 K 比对"——
   * 反证时把 TOP_K 改成 4，check 依然全绿：因为脚本的 K 本来就来自
   * retrieve.ts，**同义反复，等于没查**。
   * 真正有效的是把它打印出来：改 TOP_K 的人会立刻在输出里看到 K 变了，
   * 从而知道 eval/RESULTS.md 的历史基线作废（C1 要求基线记录 K 值）。
   */
  console.log(
    `K=${K}（来源 src/lib/retrieve.ts 的 TOP_K；改它会让 eval/RESULTS.md 的历史基线作废）`,
  );
  /**
   * prompt 与采样参数也打印出来（C1 要求基线记录它们）。
   * 这不是校验 —— 脚本和 llm.ts 读的是同一个 JSON，本来就不可能不一致；
   * 打印的目的是让人**看见自己正在用哪一版 prompt**。
   * 改 prompt 后不看这行、直接拿新结果和旧基线比，是 C4-b 最容易犯的错。
   */
  console.log(
    `prompt: rules=${prompt.system.rules.length} 条 / temperature=${prompt.sampling.temperature}` +
      `（来源 src/lib/rag-prompt.json，与线上 llm.ts 同源）`,
  );

  if (errors.length) {
    console.error(`\nFAILED：${errors.length} 个问题`);
    process.exit(1);
  }
  console.log(`OK: ${cases.length} cases`);
}

// ---------- 检索 ----------
async function embedOne(text) {
  if (!env.EMBED_API_KEY || !env.EMBED_MODEL) {
    throw new Error('缺少 EMBED_API_KEY / EMBED_MODEL（检查 .env.local）');
  }
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(`${EMBED_BASE_URL}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.EMBED_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: env.EMBED_MODEL, input: [text] }),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`embedding HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 800 * attempt));
        continue;
      }
      if (!res.ok) {
        throw new Error(`embedding HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
      }
      const json = await res.json();
      const vector = json.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length !== 1024) {
        throw new Error(`向量维度异常：${vector?.length}`);
      }
      return vector;
    } catch (e) {
      lastError = e;
      if (attempt === 3) break;
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  throw lastError ?? new Error('embedding 失败');
}

async function searchChunks(client, kbId, question) {
  const vector = await embedOne(question);
  const literal = `[${vector.join(',')}]`;
  const { rows } = await client.query(
    `select c."chunkIndex",
            d.id as "documentId",
            1 - (c.embedding <=> $1::vector) as sim
     from "Chunk" c
     join "Document" d on d.id = c."documentId"
     where d."kbId" = $2 and d.status = 'ready'
     /* 排序键先 round 到 3 位小数再比（B3 实测后改的，见 spec 修订 V17）：
        只加 "chunkIndex" asc 二级排序是不够的，它只在完全相等时才生效。
        远程 embedding 的浮点抖动可达 1e-3（实测同一句问题 0.593 / 0.594），
        第 4、5 名的差可能小于抖动幅度 → 顺序翻转、分数不变，B3 随机假红。
        round 到 3 位 = 把差异小于测量噪声的两块正式视为并列，再由 chunkIndex
        定序 —— 确定性因此是构造出来的，不是碰巧的。
        代价：真实差异 < 0.001 的两块可能被 chunkIndex 覆盖顺序，
        只影响并列边界，不影响 recall。注意：SQL 注释不能用反引号，
        它会把外层模板字符串提前闭合（本文件已踩过一次）。 */
     order by round((c.embedding <=> $1::vector)::numeric, 3) asc, c."chunkIndex" asc
     limit $3`,
    [literal, kbId, DEEP],
  );
  return rows.map((r) => ({
    chunkIndex: r.chunkIndex,
    documentId: r.documentId,
    similarity: Number(r.sim),
  }));
}

// ---------- 答案层（--with-llm） ----------
function buildMessages(question, chunks) {
  const context = chunks.length
    ? chunks
        .map((c, i) =>
          prompt.contextItem
            .replace('{no}', () => String(i + 1))
            .replace('{title}', () => c.documentTitle)
            .replace('{page}', () => String(c.chunkIndex + 1))
            .replace('{content}', () => c.content),
        )
        .join('\n\n')
    : prompt.contextEmpty;

  // 规则编号动态生成（与 llm.ts 保持一致）：rules 条数会随 prompt 修订变化，
  // 写死 "4." 会在加了第 4 条规则之后撞号。
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

async function askLlm(question, chunks) {
  if (!env.LLM_API_KEY || !env.LLM_MODEL) {
    throw new Error('缺少 LLM_API_KEY / LLM_MODEL（检查 .env.local）');
  }
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.LLM_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.LLM_MODEL,
      stream: false,
      messages: buildMessages(question, chunks),
      // 与线上 llm.ts 同源（rag-prompt.json 的 sampling.temperature）
      temperature: prompt.sampling.temperature,
      // 唯一实测有效的关闭思考方式（见 scripts/verify-chat.mjs 的三组对照）
      thinking: { type: 'disabled' },
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
}

// ---------- 主流程 ----------
const client = new pg.Client({
  connectionString: env.DIRECT_URL,
  ssl: { rejectUnauthorized: true },
  connectionTimeoutMillis: 15000,
});
await client.connect();

const t0 = Date.now();
try {
  await runCheck(client);
  if (CHECK_ONLY) {
    await client.end();
    console.error(`[check] 耗时 ${Date.now() - t0}ms`); // 耗时只走 stderr（B1）
    process.exit(0);
  }

  const results = [];
  for (const c of cases) {
    try {
      const { rows: docs } = await client.query(
        `select id, "kbId" from "Document" where title = $1`,
        [c.documentTitle],
      );
      if (docs.length !== 1) throw new Error(`文档定位失败（匹配 ${docs.length} 个）`);
      const doc = docs[0];

      const hits = await searchChunks(client, doc.kbId, c.question);

      // 只统计属于目标文档的命中，其他文档的记为 x
      const targetIndices = hits
        .filter((h) => h.documentId === doc.id)
        .map((h) => h.chunkIndex);
      const expect = c.expectChunks.map((e) => e.index);

      /**
       * recall@K 必须按"期望片段在召回序列里的**位置**"算，不能只看
       * "进没进前 K 条"——因为序列里可能混着其他文档的片段（记作 x）。
       * 一个期望块排在位置 3 但前面有 2 个 x，它在 @3 里就是没进。
       */
      const position = new Map();
      hits.forEach((h, pos) => {
        if (h.documentId === doc.id && !position.has(h.chunkIndex)) {
          position.set(h.chunkIndex, pos);
        }
      });
      const recallAt = (k) =>
        expect.filter((idx) => (position.get(idx) ?? Infinity) < k).length / expect.length;

      const recall = recallAt(K);
      const matchedCount = expect.filter((idx) => targetIndices.includes(idx)).length;

      const topAll = hits.map((h) => {
        if (h.documentId !== doc.id) return 'x';
        return VERBOSE ? `${h.chunkIndex}(${h.similarity.toFixed(3)})` : String(h.chunkIndex);
      });

      results.push({ id: c.id, recallAt, ok: true });

      /**
       * 固定打印 @1/@3/@5（同一把尺子），K≠5 时额外标出线上实际生效的 @K：
       * 调小 K 时看到「@5 高、@3 低」就说明召回变窄，而不是度量口径漂了。
       */
      const kTag = K === 5 ? '' : ` @${K}(线上)=${recallAt(K).toFixed(2)}`;
      console.log(
        `${c.id} @1=${recallAt(1).toFixed(2)} @3=${recallAt(3).toFixed(2)} ` +
          `@5=${recallAt(5).toFixed(2)}${kTag} hit=${matchedCount}/${expect.length} ` +
          `expect=[${expect.join(',')}] top${DEEP}=[${topAll.join(',')}]`,
      );

      if (WITH_LLM) {
        // 答案层：人工对照关键词，脚本不自动判分（决策②）
        /**
         * 喂给 LLM 的上下文必须是**前 K 条**，不是 DEEP 条。
         * `hits` 有 DEEP(≥5) 条是为了让 @1/@3/@5 用同一把尺子；
         * 但线上 route.ts 只会把 TOP_K 条塞进 prompt —— 用 hits 全量喂，
         * 改 TOP_K 的实验在答案层就完全测不出效果（上下文根本没变）。
         */
        const chosen = hits.slice(0, K);
        const withContent = await client.query(
          `select c."chunkIndex", c."content", d.title
           from "Chunk" c join "Document" d on d.id = c."documentId"
           where d.id = $1 and c."chunkIndex" = any($2::int[])`,
          [doc.id, chosen.map((h) => h.chunkIndex)],
        );
        const byIndex = new Map(withContent.rows.map((r) => [r.chunkIndex, r]));
        const chunksForLlm = chosen
          .map((h) => byIndex.get(h.chunkIndex))
          .filter(Boolean)
          .map((r) => ({
            chunkIndex: r.chunkIndex,
            content: r.content,
            documentTitle: r.title,
          }));

        const answer = await askLlm(c.question, chunksForLlm);
        const flat = answer.replace(/\s+/g, '');
        const marks = (c.answerMustContain ?? []).map(
          (kw) => `${kw} ${flat.includes(String(kw).replace(/\s+/g, '')) ? '✓' : '✗'}`,
        );
        console.log(`    Q: ${c.question}`);
        console.log(`    A: ${answer.replace(/\n+/g, ' ').slice(0, 200)}`);
        if (marks.length) console.log(`    keywords: ${marks.join(' / ')}`);
      }
    } catch (e) {
      results.push({ id: c.id, recall: 0, ok: false });
      error(`${c.id} ${e.message}`);
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  if (failed) {
    console.log(`TOTAL: FAILED (${failed} errors)`);
    process.exitCode = 1;
  } else {
    /**
     * 同时报 @1 / @3 / @5（W6 实测后加的，spec 修订 V13）：
     * 库里只有 9 块时 TOP_K=5 覆盖 55% —— @5 必然接近 1.000，
     * 调优改了参数也看不出差别（天花板效应）。@1/@3 才有区分度。
     * @K 仍然保留：它是与线上 TOP_K 对齐的那个数，不能只看严格的指标。
     */
    const mean = (k) => results.reduce((s, r) => s + r.recallAt(k), 0) / results.length;
    for (const k of [1, 3, 5]) {
      console.log(`TOTAL recall@${k} = ${mean(k).toFixed(3)}`);
    }
    // K≠5 时才单独报线上口径，避免同一个数字打印两次
    if (K !== 5) console.log(`TOTAL recall@${K}（线上 TOP_K 生效口径） = ${mean(K).toFixed(3)}`);
    console.log(`(${results.length} cases)`);
  }
} catch (e) {
  error(`未捕获异常：${e.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
  console.error(`[eval] 耗时 ${Date.now() - t0}ms`); // 只走 stderr（B1）
}
