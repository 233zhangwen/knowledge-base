/**
 * W15 扩库脚本：把 kb-fixtures 里的干扰文档灌进评测知识库。
 *
 * ⚠️ 与 W14 的 seed-injection-fixtures.mjs 的关键区别：
 *   那个脚本为了造"单块投毒文档"直接塞 content，**绕过了 parse.ts**，
 *   结果 W14 收尾时发现库里的 i11 仍含 70 个零宽字符（清洗层根本没跑）。
 *   这个脚本走**真实链路**：extractText → splitText → embedTexts，
 *   三个模块都是直接 import 生产代码（tsconfig 开了 allowImportingTsExtensions），
 *   不是复刻一份逻辑 —— 复刻的那份一定会和真的漂移。
 *
 * ⚠️ 为什么 parse.ts 要生成临时副本：
 *   它内部写的是 `from './untrusted'`（无扩展名，Next 的 bundler 能解析），
 *   而 Node 的 ESM 要求相对路径带扩展名。tsconfig 允许带 .ts 后缀，所以
 *   把这一处替换掉生成副本即可 —— **业务逻辑一个字不动**，只改 import 路径。
 *   用完即删（.seed-tmp/ 已在 .gitignore）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/seed-kb-fixtures.mts --dry
 *       只解析 + 切片 + 打印块数，不连库、不调 API
 *   node --experimental-strip-types scripts/seed-kb-fixtures.mts
 *       写入知识库C（幂等：先按标题删同库旧文档）
 *   node --experimental-strip-types scripts/seed-kb-fixtures.mts --clean
 *       只删不建
 *
 * 需要联网时前置：代理要开（EMBED 走 api.siliconflow.cn），命令前加 NODE_USE_ENV_PROXY=1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const CLEAN = argv.includes('--clean');
const kbArg = argv.find((a) => a.startsWith('--kb='));
const KB_NAME = kbArg ? kbArg.slice('--kb='.length) : '知识库C';

/**
 * --dir=<path> 可以把素材目录指到别处，只配合 --dry 用（探查某份文档的块划分）。
 * 之所以需要它：写 cases.json 的 snippet 指纹必须与**真实切片结果**对齐，
 * 靠肉眼估"大概在第几块"是一定会错的。
 */
const dirArg = argv.find((a) => a.startsWith('--dir='));
const FIXTURE_DIR = dirArg
  ? path.resolve(dirArg.slice('--dir='.length))
  : path.join(ROOT, 'kb-fixtures');

/** 00- 开头的是给人看的用法说明，不是评测素材。 */
const SKIP_PREFIX = '00-';

// ---------- .env.local ----------
// 必须在这里手写解析：脚本在 import 生产模块之前就要把 process.env 填好，
// 而 dotenv 的自动加载发生在 import 之后。解析规则与项目其余脚本保持一致。
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

/**
 * 把 parse.ts 里无扩展名的相对 import 补上 .ts，写到 .seed-tmp/。
 * 只动 `from './xxx'` 这一种形态；别的写法出现就原样保留（宁可报错也不猜）。
 */
function materializeParse() {
  const srcPath = path.join(ROOT, 'src', 'lib', 'parse.ts');
  const outDir = path.join(ROOT, '.seed-tmp');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'parse.ts');

  const patched = fs.readFileSync(srcPath, 'utf8').replace(/from '\.\/([^']+)'/g, (whole, p) => {
    if (p.endsWith('.ts')) return whole; // 已经带了就别重复补
    return `from '../src/lib/${p}.ts'`;
  });

  fs.writeFileSync(outPath, patched);
  return outPath;
}

function cleanupTmp() {
  const outPath = path.join(ROOT, '.seed-tmp', 'parse.ts');
  try {
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    fs.rmdirSync(path.join(ROOT, '.seed-tmp'));
  } catch {
    // 删不掉不影响结论（.seed-tmp 已 gitignore），留给人工清
  }
}

// ---------- 真实模块 ----------
const parseTmp = materializeParse();
const { extractText } = await import(pathToFileURL(parseTmp).href);
const { splitText } = await import(pathToFileURL(path.join(ROOT, 'src/lib/chunk.ts')).href);
if (DRY && CLEAN) {
  console.error('--dry 与 --clean 不能同时用');
  process.exit(1);
}

// ---------- 收集素材 ----------
const files = fs
  .readdirSync(FIXTURE_DIR)
  .filter((f) => !f.startsWith(SKIP_PREFIX) && /\.(md|txt)$/i.test(f))
  .sort();

if (!files.length) {
  console.error(`kb-fixtures/ 下没有可入库的 .md/.txt（已跳过 ${SKIP_PREFIX} 开头的说明文件）`);
  cleanupTmp();
  process.exit(1);
}

// ---------- 解析 + 切片（这一步纯本地，dry 模式到此为止） ----------
/** 一篇待入库的素材：解析后的正文 + 切片结果。 */
type Prepared = {
  file: string;
  title: string;
  content: string;
  chunks: string[];
  totalChars: number;
};

const prepared: Prepared[] = [];
for (const file of files) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, file)));
  const content: string = await extractText(bytes, 'md');
  const chunks: string[] = splitText(content);

  // W14 的不可见字符清洗在 parse.normalize 里，走真实链路就该是干净的。
  // 这里做一次断言：如果解析产物里还有零宽字符，说明清洗层出了问题，宁可停下。
  const invisible = (content.match(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g) ?? []).length;
  if (invisible > 0) {
    console.error(`✗ ${file} 解析后仍含 ${invisible} 个不可见字符 —— 清洗层失效，停止`);
    cleanupTmp();
    process.exit(1);
  }

  const totalChars = chunks.reduce((s, c) => s + c.length, 0);
  prepared.push({ file, title: file, content, chunks, totalChars });

  console.log(
    `${String(chunks.length).padStart(2)} 块 · ${String(content.length).padStart(5)} 字 · ${String(totalChars).padStart(5)} 块内字 · ${file}`,
  );
}

const grandTotal = prepared.reduce((s, p) => s + p.chunks.length, 0);
console.log(`\n新增合计：${prepared.length} 篇 / ${grandTotal} 块`);

if (DRY) {
  // 打印每篇的块首行，方便对着它写 cases.json 的 snippet 指纹
  if (argv.includes('--show')) {
    for (const p of prepared) {
      console.log(`\n=== ${p.title} ===`);
      p.chunks.forEach((c, i) => {
        console.log(`  [${i}] ${c.replace(/\s+/g, ' ').slice(0, 120)}`);
      });
    }
  }
  console.log('\n--dry：未连库、未调 API。去掉 --dry 才真正入库。');
  cleanupTmp();
  process.exit(0);
}

// ---------- 以下需要连库 ----------
const { default: pg } = await import('pg');
const client = new pg.Client({
  connectionString: process.env.DIRECT_URL,
  ssl: { rejectUnauthorized: true },
  connectionTimeoutMillis: 15000,
});
await client.connect();

/** 库名必须唯一命中，否则宁可停下 —— 同名库会让"按名字锁库"这个纪律失效（W6 V11 的教训）。 */
const { rows: kbRows } = await client.query(
  `select id, name from "KnowledgeBase" where name = $1`,
  [KB_NAME],
);
if (kbRows.length !== 1) {
  const { rows: all } = await client.query(`select name from "KnowledgeBase" order by "createdAt"`);
  console.error(
    `知识库「${KB_NAME}」匹配到 ${kbRows.length} 个（必须恰好 1 个）。现有库：\n` +
      all.map((r) => `  - ${r.name}`).join('\n'),
  );
  await client.end();
  cleanupTmp();
  process.exit(1);
}
const kbId = kbRows[0].id;
console.log(`\n目标知识库「${KB_NAME}」 id=${kbId}`);

const titles = prepared.map((p) => p.title);
const { rows: existing } = await client.query(
  `select id, title from "Document" where "kbId" = $1 and title = any($2::text[])`,
  [kbId, titles],
);
if (existing.length) {
  await client.query(`delete from "Document" where id = any($1::text[])`, [
    existing.map((d) => d.id),
  ]);
  console.log(`删除同标题旧文档 ${existing.length} 个（Chunk 级联）`);
}

if (CLEAN) {
  const { rows: now } = await client.query(
    `select count(distinct d.id) as docs, count(c.id) as chunks
       from "Document" d left join "Chunk" c on c."documentId" = d.id
      where d."kbId" = $1`,
    [kbId],
  );
  console.log(`清理完成。该库现有 ${now[0].docs} 篇文档 / ${now[0].chunks} 块`);
  await client.end();
  cleanupTmp();
  process.exit(0);
}

// ---------- 向量 + 写库 ----------
const { embedTexts } = await import(pathToFileURL(path.join(ROOT, 'src/lib/embedding.ts')).href);
const { findSuspicious } = await import(
  pathToFileURL(path.join(ROOT, 'src/lib/untrusted.ts')).href
);

for (const p of prepared) {
  const vectors = await embedTexts(p.chunks);
  if (vectors.length !== p.chunks.length) {
    console.error(`✗ ${p.title} 向量数(${vectors.length}) ≠ 块数(${p.chunks.length})，停止`);
    await client.end();
    cleanupTmp();
    process.exit(1);
  }

  // W14 的可疑标记：真实调用生产函数，走和 indexDocument 一样的口径
  const hits = findSuspicious(p.content);
  const docId = `doc-w15-${Buffer.from(p.file).toString('hex').slice(0, 12)}`;

  await client.query(
    `insert into "Document" (id, title, "sourceType", "sizeBytes", status, content, "kbId",
                             "suspiciousAt", "createdAt")
     values ($1, $2, 'md', $3, 'ready', $4, $5, $6, now())`,
    [
      docId,
      p.title,
      Buffer.byteLength(p.content, 'utf8'),
      p.content,
      kbId,
      hits.length ? new Date() : null,
    ],
  );

  for (const [i, chunk] of p.chunks.entries()) {
    const literal = `[${vectors[i].join(',')}]`;
    await client.query(
      `insert into "Chunk" (id, content, "chunkIndex", "documentId", embedding)
       values ($1, $2, $3, $4, $5::vector)`,
      [`chk-w15-${docId.slice(8)}-${i}`, chunk, i, docId, literal],
    );
  }

  console.log(
    `写入《${p.title}》 ${p.chunks.length} 块${hits.length ? ` ⚠️ suspicious: ${hits.join(',')}` : ''}`,
  );
}

// ---------- 汇总 ----------
const { rows: summary } = await client.query(
  `select count(distinct d.id) as docs, count(c.id) as chunks
     from "Document" d left join "Chunk" c on c."documentId" = d.id
    where d."kbId" = $1 and d.status = 'ready'`,
  [kbId],
);
console.log(
  `\n完成。知识库「${KB_NAME}」现有 ${summary[0].docs} 篇 ready 文档 / 共 ${summary[0].chunks} 块`,
);
console.log('下一步：node scripts/eval.mjs --check 验 25 条旧标注有没有被扩库搞坏');

await client.end();
cleanupTmp();
