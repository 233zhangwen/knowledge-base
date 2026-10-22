/**
 * 验证 Neon Postgres 配置是否可用。
 * 用法：node scripts/verify-db.mjs
 *
 * 四关：
 *   1. 静态检查连接串（pooler/直连有没有填反、有没有残留 channel_binding）
 *   2. 连通性 + 延迟（pooled 和 direct 各测一次）
 *   3. pgvector 扩展能否启用，版本多少
 *   4. 向量运算能不能跑（cosine 距离 <=>），并顺手算一个 1024 维的
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

// ---------- 手搓 .env.local 解析（不引第三方依赖） ----------
function loadEnv(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = loadEnv(path.resolve(process.cwd(), '.env.local'));
const DB_URL = env.DATABASE_URL;
const DIR_URL = env.DIRECT_URL;

// ---------- 小工具：把密码打码，避免日志/截图泄露 ----------
function hidePwd(url) {
  if (!url) return '(缺失)';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username}:****@${u.host}${u.pathname}`;
  } catch {
    return '(不是合法的 URL)';
  }
}

const fail = (msg) => {
  console.error(`   ❌ ${msg}`);
  process.exit(1);
};

console.log('==============================================');
console.log(' Neon Postgres 配置验证');
console.log('==============================================');
console.log(`DATABASE_URL (pooled) : ${hidePwd(DB_URL)}`);
console.log(`DIRECT_URL   (direct) : ${hidePwd(DIR_URL)}`);
console.log('');

// ---------- 1. 静态检查 ----------
console.log('【1】连接串静态检查...');
if (!DB_URL) fail('缺少 DATABASE_URL');
if (!DIR_URL) fail('缺少 DIRECT_URL');

const problems = [];

for (const [label, url] of [['DATABASE_URL', DB_URL], ['DIRECT_URL', DIR_URL]]) {
  if (!url.startsWith('postgresql://') && !url.startsWith('postgres://')) {
    problems.push(`${label} 不是 postgres 连接串（应以 postgresql:// 开头）`);
  }
  if (/[[\]]/.test(url)) {
    problems.push(`${label} 还留着占位符 [xxx]，没替换成真实值`);
  }
  if (/channel_binding/i.test(url)) {
    problems.push(`${label} 含 channel_binding —— Prisma 和 Node 驱动都不认这个参数，删掉它`);
  }
  if (!/sslmode=/i.test(url)) {
    problems.push(`${label} 缺 sslmode=require，Neon 必须走 SSL`);
  }
}

// pooled 应该有 -pooler，direct 不应该有
const dbHasPooler = DB_URL.includes('-pooler');
const dirHasPooler = DIR_URL.includes('-pooler');
if (!dbHasPooler) {
  problems.push('DATABASE_URL 里看不到 -pooler，你填的可能是直连地址（填反了）');
}
if (dirHasPooler) {
  problems.push('DIRECT_URL 里带了 -pooler，这是 pooled 地址；迁移必须用不带 -pooler 的直连地址');
}
if (dbHasPooler && dirHasPooler) {
  problems.push('两个串都带 -pooler，说明是同一个地址，确认一下有没有复制两次');
}

if (problems.length) {
  for (const p of problems) console.error(`   ❌ ${p}`);
  process.exit(1);
}
console.log('   ✅ 格式正确，pooled / direct 没填反');
console.log('');

// ---------- 2. 连通性 + 延迟 ----------
async function connect(url, label) {
  const t0 = Date.now();
  const client = new pg.Client({
    connectionString: url,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 15000,
  });
  await client.connect();
  const version = (await client.query('SELECT version()')).rows[0].version;
  return { client, version, latency: Date.now() - t0, label };
}

let direct;
let pooled;
try {
  console.log('【2】连通性测试...');
  direct = await connect(DIR_URL, 'direct');
  console.log(`   ✅ 直连      ${direct.latency}ms`);
  pooled = await connect(DB_URL, 'pooled');
  console.log(`   ✅ 连接池    ${pooled.latency}ms`);
} catch (e) {
  console.error(`   ❌ 连不上：${e.message}`);
  console.error('   常见原因：密码没复制全 / 没删 channel_binding / 本地网络不通 Neon / 项目被暂停（Neon 免费层长时间无访问会挂起，去控制台唤醒）');
  process.exit(1);
}
console.log(`   Postgres: ${direct.version.split(',')[0]}`);
console.log('');

// ---------- 3. pgvector ----------
console.log('【3】检查 pgvector 扩展...');
let extVersion = null;
try {
  await direct.client.query('CREATE EXTENSION IF NOT EXISTS vector');
  const r = await direct.client.query(
    "SELECT extversion FROM pg_extension WHERE extname = 'vector'"
  );
  extVersion = r.rows[0]?.extversion;
  if (!extVersion) fail('CREATE EXTENSION 没报错，但查不到 vector 扩展');
  console.log(`   ✅ pgvector 可用，版本 ${extVersion}`);
} catch (e) {
  console.error(`   ❌ pgvector 启用失败：${e.message}`);
  console.error('   Neon 支持 pgvector，但必须在「直连」地址上执行；确认 DIRECT_URL 没填成 pooled 地址。');
  process.exit(1);
}
console.log('');

// ---------- 4. 向量运算 ----------
console.log('【4】测试向量运算（1024 维 + cosine 距离）...');
try {
  const dims = 1024; // bge-m3 输出维度，务必与 EMBED_MODEL 一致
  const a = `[${Array(dims).fill(0).map((_, i) => (i % 7) / 7).join(',')}]`;
  const b = `[${Array(dims).fill(0).map((_, i) => (i % 5) / 5).join(',')}]`;
  const r = await direct.client.query(
    'SELECT $1::vector AS va, $1::vector <=> $2::vector AS cosine_distance',
    [a, b]
  );
  const d = Number(r.rows[0].cosine_distance);
  console.log(`   ✅ 能存 ${dims} 维向量，cosine 距离 = ${d.toFixed(6)}`);
  if (Number.isNaN(d)) fail('cosine 距离算出来是 NaN');
} catch (e) {
  console.error(`   ❌ 向量运算失败：${e.message}`);
  process.exit(1);
}
console.log('');

await direct.client.end();
await pooled.client.end();

console.log('==============================================');
console.log(' ✅ 数据库配置验证通过，可以开工了。');
console.log('==============================================');
