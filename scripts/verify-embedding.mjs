/**
 * 验证硅基流动 Embedding 配置是否可用，并探测 batch 上限。
 * 用法：node scripts/verify-embedding.mjs
 *
 * 为什么 W3 开工前必须先跑这个：
 *   pgvector 的列在建表时就写死了 vector(1024)。如果模型返回的是别的维度
 *   （换错模型、服务商改了默认输出），错误会一路拖到「写入数据库」那一刻才炸，
 *   而且报错信息是英文的数据库底层错误，很难联想到是模型选错了。
 *   所以这里先把它钉死：不是 1024 维就直接退出，别往下写业务代码。
 *
 * 做三件事：
 *   1. 确认模型 ID 在你的账号里可用（顺带确认 EMBED_MODEL 没填错）
 *   2. 小批量调用，断言返回维度 = 1024，并肉眼确认不是全 0
 *   3. 探测一次请求最多能塞多少条文本（决定代码里的 batch 大小）
 *
 * 零第三方依赖：.env.local 自己解析，请求用内置 fetch。
 */
import fs from 'node:fs';
import path from 'node:path';

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
const API_KEY = env.EMBED_API_KEY;
const BASE_URL = (env.EMBED_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
const MODEL = env.EMBED_MODEL;

/** 这个数字必须和 prisma/schema.prisma 里 vector(1024) 保持一致。改一个就得改另一个。 */
const EXPECTED_DIMENSIONS = 1024;

const mask = (k) => (k ? `${k.slice(0, 8)}...${k.slice(-4)}` : '(缺失)');

console.log('==============================================');
console.log(' 硅基流动 Embedding 配置验证');
console.log('==============================================');
console.log(`BASE_URL : ${BASE_URL}`);
console.log(`API_KEY  : ${mask(API_KEY)}`);
console.log(`MODEL    : ${MODEL || '(缺失)'}`);
console.log(`期望维度 : ${EXPECTED_DIMENSIONS}`);
console.log('');

if (!API_KEY) {
  console.error('❌ .env.local 里没有 EMBED_API_KEY，先去补上再跑。');
  process.exit(1);
}
if (!MODEL) {
  console.error('❌ .env.local 里没有 EMBED_MODEL（应填 BAAI/bge-m3）。');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

/** 统一发一次 embeddings 请求。失败会把响应正文打出来 —— 服务商的报错信息都在里面。 */
async function callEmbeddings(input) {
  const res = await fetch(`${BASE_URL}/embeddings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: MODEL, input }),
  });

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 600);
    try {
      const j = JSON.parse(text);
      detail = j.message || j.error?.message || detail;
    } catch {
      /* 不是 JSON 就原样打 */
    }
    throw new Error(`HTTP ${res.status} — ${detail}`);
  }

  const json = JSON.parse(text);
  if (!Array.isArray(json.data)) {
    throw new Error(`响应里没有 data 数组：${text.slice(0, 300)}`);
  }
  return json;
}

// ---------- 1. 确认模型可用 ----------
console.log('【1】拉取可用模型列表...');
try {
  /**
   * 注意和 verify-llm.mjs 不一样：DeepSeek 的模型列表在根路径 /models，
   * 而硅基流动在 /v1/models。这里的 BASE_URL 本身带 /v1，直接拼 /models 即可。
   */
  const res = await fetch(`${BASE_URL}/models`, { headers });
  if (!res.ok) {
    console.log(`   ⚠️  拉不到模型列表（HTTP ${res.status}），跳过这步，不影响后续。`);
  } else {
    const json = await res.json();
    const ids = (json.data || []).map((m) => m.id).sort();
    console.log(`   账号可用 ${ids.length} 个模型，含 embedding 关键词的有：`);
    const embedLike = ids.filter((id) => /embed|bge|gte|e5/i.test(id));
    for (const id of embedLike.length ? embedLike : ids.slice(0, 20)) console.log(`     - ${id}`);
    if (ids.length && !ids.includes(MODEL)) {
      console.log('');
      console.log(`   ❌ .env.local 里的 EMBED_MODEL=${MODEL} 不在这个列表里！`);
      console.log(`      从上面挑一个 embedding 模型的 ID 填进去，然后重跑本脚本。`);
      process.exit(1);
    }
    if (ids.includes(MODEL)) console.log(`   ✅ ${MODEL} 在可用列表里`);
  }
} catch (e) {
  console.log(`   ⚠️  请求失败：${e.message}`);
}
console.log('');

// ---------- 2. 小批量调用 + 维度断言 ----------
console.log('【2】发送 2 条测试文本...');
let usageSeen = null;
try {
  const input = ['海水为什么是咸的', '成都今天天气怎么样'];
  const started = Date.now();
  const json = await callEmbeddings(input);
  const elapsed = Date.now() - started;

  if (json.data.length !== input.length) {
    console.error(`   ❌ 返回 ${json.data.length} 条，期望 ${input.length} 条 —— 批量返回对不上，后面按索引取向量会错位。`);
    process.exit(1);
  }

  const first = json.data[0].embedding;
  const dims = Array.isArray(first) ? first.length : -1;
  usageSeen = json.usage || null;

  console.log(`   返回条数: ${json.data.length} ✅`);
  console.log(`   维度    : ${dims} ${dims === EXPECTED_DIMENSIONS ? '✅' : '❌'}`);
  console.log(`   前 5 个值: ${first.slice(0, 5).map((n) => n.toFixed(6)).join(', ')}`);
  console.log(`   tokens  : ${usageSeen ? usageSeen.total_tokens : '(未返回)'}`);
  console.log(`   耗时    : ${elapsed}ms`);

  if (dims !== EXPECTED_DIMENSIONS) {
    console.error('');
    console.error(`   ❌ 维度是 ${dims}，不是 ${EXPECTED_DIMENSIONS}。`);
    console.error(`      pgvector 的列是写死的 vector(${EXPECTED_DIMENSIONS})，写进去会报`);
    console.error(`      "expected ${EXPECTED_DIMENSIONS} dimensions, not ${dims}"。`);
    console.error(`      要么把 EMBED_MODEL 换成 bge-m3，要么改 schema 的 vector(N) 并重跑迁移（含索引）。`);
    process.exit(1);
  }

  // 全 0 向量永远检索不到任何东西，而且不会报错 —— 必须在这里拦住
  const allZero = first.every((n) => n === 0);
  if (allZero) {
    console.error('   ❌ 返回的是全 0 向量：模型没算出东西（常见于传了空字符串或模型异常）。');
    process.exit(1);
  }
  console.log('   ✅ 维度与内容都正常');
} catch (e) {
  console.error(`   ❌ 请求失败：${e.message}`);
  console.error('      常见原因：EMBED_BASE_URL 少了 /v1；API_KEY 没充值或被吊销；本机代理没开。');
  process.exit(1);
}
console.log('');

// ---------- 3. 探测 batch 上限 ----------
console.log('【3】探测一次请求最多能塞多少条（决定代码里的 batch 大小）...');
const PROBE_SIZES = [32, 16, 8];
let recommended = null;

for (const size of PROBE_SIZES) {
  const input = Array.from({ length: size }, (_, i) => `第 ${i + 1} 条测试文本，用于探测批量上限。`);
  try {
    const started = Date.now();
    const json = await callEmbeddings(input);
    if (json.data.length === size) {
      console.log(`   ${String(size).padStart(2)} 条 → ✅ 成功（${Date.now() - started}ms）`);
      recommended = size;
      break;
    }
    console.log(`   ${String(size).padStart(2)} 条 → ⚠️ 只返回 ${json.data.length} 条，视为不支持`);
  } catch (e) {
    console.log(`   ${String(size).padStart(2)} 条 → ❌ ${e.message.slice(0, 120)}`);
  }
}

console.log('');
console.log('==============================================');
if (recommended) {
  console.log(` ✅ Embedding 验证通过。`);
  console.log(`   建议写进 src/lib/embedding.ts：EMBED_BATCH_SIZE = ${recommended}`);
  console.log(`   （实际用的时候留点余量，别贴着上限走 —— 文本一大就容易触发总 token 限制。）`);
} else {
  console.log(' ❌ 连最小的 8 条批量都失败了，先解决上面的报错再往下走。');
}
console.log('==============================================');
