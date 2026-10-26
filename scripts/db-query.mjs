/**
 * 直连 Neon 跑 SQL。零依赖新增（复用已有的 pg 驱动），不用装 psql。
 *
 * 用法（在自己终端跑，PowerShell / Git Bash 都行）：
 *
 *   node scripts/db-query.mjs                      # 无参数：跑一套 W3 预设检查
 *   node scripts/db-query.mjs "select count(*) from \"Chunk\";"   # 有参数：执行这条 SQL
 *
 * 两个约定：
 *   1. 走 DIRECT_URL（直连）。查库是低频操作，不占连接池；且 pooled 地址上
 *      某些 DDL / 扩展查询会失败，直连最稳。
 *   2. 只做查询展示，不写数据。要改数据请走 Prisma 或显式 UPDATE。
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

// ---------- .env.local 解析 ----------
// 注意和 dotenv 保持一致：值若以引号开头，取到「下一个成对引号」为止，
// 这样 `KEY="value"   # 行尾注释` 也能正确解析（不能简单地去掉首尾字符）。
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

const env = loadEnv(path.resolve(process.cwd(), '.env.local'));
const URL_ = env.DIRECT_URL;

if (!URL_) {
  console.error('❌ .env.local 里没有 DIRECT_URL');
  process.exit(1);
}
if (/channel_binding/i.test(URL_)) {
  console.error('❌ DIRECT_URL 含 channel_binding，Node 驱动不认，删掉它');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: URL_,
  ssl: { rejectUnauthorized: true },
  connectionTimeoutMillis: 15000,
});

// ---------- 结果打印 ----------
// vector 列打出来是上千个数字，必须截断，否则一屏刷爆。
function fmt(v) {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Buffer) return `<${v.length} bytes>`;
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return s.length > 48 ? `${s.slice(0, 45)}...` : s;
}

function printRows(rows) {
  if (!rows.length) {
    console.log('   (0 行)');
    return;
  }
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => fmt(r[c]).length))
  );
  console.log(`   ${cols.map((c, i) => c.padEnd(widths[i])).join(' | ')}`);
  console.log(`   ${widths.map((w) => '-'.repeat(w)).join('-+-')}`);
  for (const r of rows) {
    console.log(`   ${cols.map((c, i) => fmt(r[c]).padEnd(widths[i])).join(' | ')}`);
  }
}

async function q(label, sql, params = []) {
  console.log(`\n${label}`);
  console.log(`   SQL: ${sql.replace(/\s+/g, ' ').trim()}`);
  try {
    const r = await client.query(sql, params);
    printRows(r.rows);
    return r.rows;
  } catch (e) {
    console.error(`   ❌ ${e.message}`);
    return null;
  }
}

await client.connect();

/**
 * SQL 从哪来：argv 优先，其次 stdin。
 *
 * 为什么要支持 stdin —— PowerShell 把带双引号的参数传给 **原生命令**（node.exe）时，
 * 引号会被吃掉一层：`node db-query.mjs 'select ... from "Conversation";'`
 * 到达 Node 时已经变成 `from Conversation`，引号没了 → Postgres 报
 * `relation "conversation" does not exist`（大小写敏感，而表是用引号建的混合大小写）。
 * 走 stdin 就完全没有这层 re-parse，所以 PowerShell 里推荐这样写：
 *
 *   @'
 *   select count(*)::int from "Conversation";
 *   '@ | node scripts/db-query.mjs --stdin
 *
 * 单条短 SQL 也可以用 -s 参数（同样走 stdin 管道）：
 *   'select count(*)::int from "Conversation";' | node scripts/db-query.mjs --stdin
 */
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return chunks.join('').trim();
}

const argv = process.argv.slice(2);
const useStdin = argv.includes('--stdin');
const argvSql = argv.filter((a) => a !== '--stdin').join(' ').trim();
// 只有明确传了 --stdin 才去读：否则无参数跑预设时会在 await stdin 上永远卡住
const sql = argvSql || (useStdin ? await readStdin() : '');

if (sql) {
  // ---------- 自定义 SQL ----------
  await q('【自定义查询】', sql);
} else {
  // ---------- W3 预设检查 ----------
  console.log('==============================================');
  console.log(' W3 数据库预设检查（只读）');
  console.log('==============================================');

  const total = await q('【1】Chunk 总行数', 'select count(*)::int as chunks from "Chunk"');

  await q(
    '【2】每个文档的索引情况（对应 B2 / C2）',
    `select d.id, left(d.title, 24) as title, d.status,
            left(coalesce(d.error, ''), 28) as error,
            count(c.id)::int as chunk_count
     from "Document" d left join "Chunk" c on c."documentId" = d.id
     group by d.id order by d."createdAt" desc limit 10`
  );

  const hasChunks = Number(total?.[0]?.chunks ?? 0) > 0;

  if (!hasChunks) {
    console.log('\n⚠️  Chunk 表是空的 —— 先去页面上传一个 txt，再跑这个脚本。');
  } else {
    await q(
      '【3】向量维度必须全是 1024（对应 B1）',
      'select vector_dims(embedding) as dims, count(*) from "Chunk" group by 1'
    );

    // 与「全零向量」的 L2 距离：> 0 才说明不是全 0。
    // 用这个而不是 vector_norm()，是因为它对所有 pgvector 版本都成立，
    // 不用先查版本再决定走哪条判据。
    const zeros = `[${Array(1024).fill(0).join(',')}]`;
    await q(
      '【4】无空向量、无全零向量（对应 B3）',
      `select count(*) filter (where embedding is null) as null_count,
              min(embedding <-> $1::vector) as min_dist_from_zero,
              max(embedding <-> $1::vector) as max_dist_from_zero
       from "Chunk"`,
      [zeros]
    );

    await q(
      '【5】chunkIndex 连续无重复（对应 D1）',
      `select "documentId", count(*)::int as total,
              count(distinct "chunkIndex")::int as distinct_idx
       from "Chunk" group by "documentId" limit 10`
    );

    await q(
      '【6】最近邻冒烟：取「chunk 最多的文档」的第 0 块，查它最像的 3 块（对应 B4）',
      `select c2."chunkIndex", 1 - (c1.embedding <=> c2.embedding) as cosine_sim
       from "Chunk" c1
       join "Chunk" c2 on c2."documentId" = c1."documentId"
       where c1."documentId" = (
               select "documentId" from "Chunk"
               group by "documentId" order by count(*) desc limit 1
             )
         and c1."chunkIndex" = 0
       order by c1.embedding <=> c2.embedding
       limit 3`
    );
    console.log('   （预期：第一条是它自己 chunkIndex=0 且 sim≈1；');
    console.log('    后两条应当是语义相邻的下一段。若第 2、3 条是完全无关的段落，向量就有问题。）');
    console.log('   （想要"真查询句"级别的验证：node scripts/verify-retrieval.mjs "你的问题"）');
  }
}

await client.end();
console.log('\n完成。');
