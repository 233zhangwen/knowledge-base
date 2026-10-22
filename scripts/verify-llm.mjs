/**
 * 验证 DeepSeek LLM 配置是否可用。
 * 用法：node scripts/verify-llm.mjs
 *
 * 做三件事：
 *   1. 列出你的账号能用的模型 ID（用来确认 LLM_MODEL 填对了没）
 *   2. 查余额（确认充值到账没）
 *   3. 发一条最小中文对话（确认真的能生成）
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
const API_KEY = env.LLM_API_KEY;
const BASE_URL = (env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const MODEL = env.LLM_MODEL;
const ORIGIN = BASE_URL.replace(/\/v1$/, ''); // https://api.deepseek.com

const mask = (k) => (k ? `${k.slice(0, 8)}...${k.slice(-4)}` : '(缺失)');

console.log('==============================================');
console.log(' DeepSeek LLM 配置验证');
console.log('==============================================');
console.log(`BASE_URL : ${BASE_URL}`);
console.log(`API_KEY  : ${mask(API_KEY)}`);
console.log(`MODEL    : ${MODEL || '(缺失)'}`);
console.log('');

if (!API_KEY) {
  console.error('❌ .env.local 里没有 LLM_API_KEY，先去补上再跑。');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

// ---------- 1. 拉模型列表 ----------
console.log('【1】拉取可用模型列表...');
let modelIds = [];
try {
  const res = await fetch(`${ORIGIN}/models`, { headers });
  if (!res.ok) {
    console.log(`   ⚠️  拉不到模型列表（HTTP ${res.status}），跳过这步，不影响后续。`);
  } else {
    const json = await res.json();
    modelIds = (json.data || []).map((m) => m.id).sort();
    console.log(`   可用 ${modelIds.length} 个模型：`);
    for (const id of modelIds) console.log(`     - ${id}`);
    if (MODEL && modelIds.length && !modelIds.includes(MODEL)) {
      console.log('');
      console.log(`   ❌ .env.local 里的 LLM_MODEL=${MODEL} 不在这个列表里！`);
      console.log(`      从上面挑一个「聊天/文本生成」的 ID 填进去，然后重跑本脚本。`);
      process.exit(1);
    }
  }
} catch (e) {
  console.log(`   ⚠️  请求失败：${e.message}`);
}
console.log('');

// ---------- 2. 查余额 ----------
console.log('【2】查询账户余额...');
let hasBalance = false;
try {
  const res = await fetch(`${ORIGIN}/user/balance`, { headers });
  if (!res.ok) {
    console.log(`   ⚠️  查不到余额（HTTP ${res.status}），跳过这步。`);
  } else {
    const json = await res.json();
    const infos = json.balance_infos || [];
    if (!infos.length) {
      console.log(`   is_available = ${json.is_available}`);
    }
    for (const b of infos) {
      const total = Number(b.total_balance || 0);
      console.log(`   ${b.currency}: 总余额 ${b.total_balance}（赠送 ${b.granted_balance} / 充值 ${b.topped_up_balance}）`);
      if (total > 0) hasBalance = true;
    }
    if (!hasBalance) {
      console.log('   ❌ 余额为 0，去 DeepSeek 控制台充值（¥10 就够开发用很久），到账后重跑。');
      process.exit(1);
    }
    console.log('   ✅ 余额可用');
  }
} catch (e) {
  console.log(`   ⚠️  请求失败：${e.message}`);
}
console.log('');

// ---------- 3. 发一条中文对话 ----------
console.log('【3】发送测试对话...');
try {
  const started = Date.now();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: '你是一个简洁的助手，用中文回答，不超过 30 个字。' },
        { role: 'user', content: '用一句话解释什么是 RAG。' },
      ],
      // deepseek-flash 是推理模型，默认会先"打草稿"（reasoning_content，照样计费）。
      // RAG 问答不需要草稿，关掉：更快、更省。W4 如果要解复杂题可再打开。
      thinking: { type: 'disabled' },
      max_tokens: 512,
      stream: false,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`   ❌ HTTP ${res.status}`);
    console.error(`   ${text.slice(0, 600)}`);
    process.exit(1);
  }

  const json = JSON.parse(text);
  const choice = json.choices?.[0] || {};
  const answer = choice.message?.content?.trim();
  const reasoning = choice.message?.reasoning_content;
  const usage = json.usage || {};
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? 0;

  console.log(`   模型  : ${json.model}`);
  console.log(`   finish: ${choice.finish_reason}`);
  if (reasoning) {
    console.log(`   ⚠️  模型仍在"打草稿"（reasoning_tokens=${reasoningTokens}），thinking 开关没生效？`);
  }
  console.log(`   回答  : ${answer || '(空!)'}`);
  console.log(`   tokens: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens}（其中思考 ${reasoningTokens}） total=${usage.total_tokens}`);
  console.log(`   耗时  : ${Date.now() - started}ms`);
  console.log('');

  if (!answer) {
    console.error('   ❌ 回答为空 —— 即使_tokens 够用也没产出正文，检查模型/参数。不通过。');
    process.exit(1);
  }
  console.log('==============================================');
  console.log(' ✅ LLM 配置验证通过，可以开工了。');
  console.log('==============================================');
} catch (e) {
  console.error(`   ❌ 请求失败：${e.message}`);
  process.exit(1);
}
