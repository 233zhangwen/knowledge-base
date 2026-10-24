/**
 * 开工前必验：DeepSeek 的流式 + 关闭"思考"这件事，到底哪个参数真的管用。
 *
 * 为什么非要单独验一次：
 *   deepseek-flash 是推理模型，默认会先输出一段 reasoning_content 再答正题，
 *   而**思考 token 照样计费**。RAG 问答不需要它打草稿，但这个参数的形式
 *   网上说法不一（enable_thinking / thinking.type），与其猜，不如三组对照实测。
 *
 * 用法：node scripts/verify-chat.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

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
const { LLM_API_KEY, LLM_MODEL } = env;
const LLM_BASE_URL = (env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');

if (!LLM_API_KEY || !LLM_MODEL) {
  console.error('❌ 缺少 LLM_API_KEY / LLM_MODEL');
  process.exit(1);
}

console.log(`模型：${LLM_MODEL}`);
console.log(`地址：${LLM_BASE_URL}\n`);

// 三组对照：不传 / 网上流传的写法 / env.example 里记的写法
const CASES = [
  { label: 'A 不传任何参数', body: {} },
  { label: 'B enable_thinking:false', body: { enable_thinking: false } },
  { label: 'C thinking:{type:disabled}', body: { thinking: { type: 'disabled' } } },
];

const QUESTION = '用一句话说明什么是向量数据库。';

async function runOne({ label, body }) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${LLM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        stream: true,
        messages: [{ role: 'user', content: QUESTION }],
        ...body,
      }),
    });
  } catch (e) {
    return { label, error: `请求失败：${e.message}` };
  }

  if (!res.ok) {
    return { label, error: `HTTP ${res.status}：${(await res.text()).slice(0, 200)}` };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let firstTextAt = 0;
  let hasReasoning = false;
  let text = '';
  let usageFinish = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // SSE：块之间用空行分隔，逐块处理
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';

    for (const part of parts) {
      for (const line of part.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        for (const choice of json.choices ?? []) {
          const d = choice.delta ?? {};
          // 思考内容走这个字段；它不是正式回答，我们不想为它付钱
          if (d.reasoning_content) hasReasoning = true;
          if (d.content) {
            if (!firstTextAt) firstTextAt = Date.now() - t0;
            text += d.content;
          }
        }
        if (json.usage) usageFinish = json.usage;
      }
    }
  }

  return {
    label,
    hasReasoning,
    firstTextMs: firstTextAt,
    totalMs: Date.now() - t0,
    chars: text.length,
    promptTokens: usageFinish?.prompt_tokens,
    completionTokens: usageFinish?.completion_tokens,
    reasoningTokens: usageFinish?.completion_tokens_details?.reasoning_tokens,
    preview: text.slice(0, 40),
  };
}

const results = [];
for (const c of CASES) {
  results.push(await runOne(c));
}

console.log('组别                        | 思考内容 | 首字延迟 | 总耗时  | 完成token | 其中思考token');
console.log('----------------------------+----------+---------+--------+----------+-------------');
for (const r of results) {
  if (r.error) {
    console.log(`${r.label.padEnd(28)} | ❌ ${r.error}`);
    continue;
  }
  console.log(
    `${r.label.padEnd(28)} | ${String(r.hasReasoning ? '有' : '无').padEnd(8)} | ` +
      `${String(r.firstTextMs + 'ms').padEnd(7)} | ${String(r.totalMs + 'ms').padEnd(6)} | ` +
      `${String(r.completionTokens ?? '-').padEnd(8)} | ${r.reasoningTokens ?? 0}`,
  );
}

console.log('\n判读：');
console.log('  · 「有思考内容」的那组 = 关失败，会多烧 token（尤其是 reasoning_tokens 那一列）');
console.log('  · 首字延迟 = W4 验收标准里「1.5 秒内出第一个字」的实测基线');
console.log('  · 哪一组 reasoning_tokens = 0 且没有 reasoning_content，代码里就用哪种写法');
console.log(`\n附：本次提问「${QUESTION}」`);
for (const r of results) {
  if (!r.error) console.log(`  ${r.label} → ${r.preview}`);
}
