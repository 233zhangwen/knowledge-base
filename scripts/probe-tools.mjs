/**
 * W9 探针（spec：docs/ACCEPTANCE-W9.md A 组）：DeepSeek function calling 可行性。
 *
 * 零依赖、非流式、假工具 —— 只验证协议，不评估检索质量。
 * 与 src/lib/llm.ts 同源：同 endpoint / 鉴权 / temperature=0 / thinking disabled。
 *
 * 用法：node scripts/probe-tools.mjs [--model deepseek-chat]
 *   --model 可换官方模型名对照（spec 漏洞 4：区分"脚本 bug"与"模型限制"）
 */
import { readFileSync } from 'node:fs';

/** 极简 .env.local 解析（不引依赖，与 verify-llm.mjs 同一思路） */
function loadEnv() {
  const env = {};
  for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)\s*$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const args = process.argv.slice(2);
const modelOverride = args.includes('--model') ? args[args.indexOf('--model') + 1] : null;

const env = loadEnv();
const apiKey = env.LLM_API_KEY;
const baseUrl = (env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const model = modelOverride || env.LLM_MODEL || 'deepseek-flash';
if (!apiKey) {
  console.error('缺少 LLM_API_KEY');
  process.exit(1);
}

/** 假检索工具：固定片段。协议验证够用，别拿它评估答案质量（spec 范围声明）。 */
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'retrieve_knowledge',
      description:
        '从用户上传的文档知识库中检索与问题相关的原文片段。凡是可能和文档内容有关的问题（制度、流程、数字、条款），都必须先调用本工具，不要凭记忆回答。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '改写后的独立、完整的检索问句' },
        },
        required: ['question'],
      },
    },
  },
];

const THINKING = { type: 'disabled' };
const TEMPERATURE = 0;

/** 非流式请求。tools 传 null 表示不带工具（D1 反证用）。 */
async function chat(messages, { tools = TOOLS, withThinking = true } = {}) {
  const body = { model, messages, temperature: TEMPERATURE, tools: tools ?? undefined };
  if (withThinking) body.thinking = THINKING;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

function summarize(tag, data, elapsed) {
  const msg = data.choices?.[0]?.message ?? {};
  const calls = msg.tool_calls ?? [];
  console.log(`\n===== ${tag}（${elapsed}ms）`);
  console.log(`finish_reason: ${data.choices?.[0]?.finish_reason}`);
  console.log(`content: ${(msg.content ?? '').slice(0, 160) || '（空）'}`);
  console.log(`tool_calls: ${calls.length}`);
  for (const c of calls) {
    console.log(`  - ${c.function?.name}(${c.function?.arguments})`);
  }
  if (msg.reasoning_content) {
    console.log(`reasoning_content: 存在（${String(msg.reasoning_content).length} 字）`);
  }
  if (data.usage) {
    console.log(
      `usage: prompt=${data.usage.prompt_tokens} completion=${data.usage.completion_tokens}`,
    );
  }
  return { msg, calls, finish: data.choices?.[0]?.finish_reason };
}

async function main() {
  console.log(`model=${model}  thinking=${JSON.stringify(THINKING)}  temperature=${TEMPERATURE}`);

  // ---------- A1：无关问题，不该调工具 ----------
  let t = Date.now();
  const r1 = await chat([{ role: 'user', content: '用一句话介绍你自己。' }]);
  const s1 = summarize('A1 无关问题（期望不调工具）', r1, Date.now() - t);
  console.log(`>>> A1 ${s1.calls.length === 0 ? 'PASS' : 'FAIL'}`);

  // ---------- A2：知识库问题，该调工具（连跑 2 次，spec 漏洞 5） ----------
  const question = '星海科技带薪年假有几天？';
  const a2 = [];
  for (let i = 1; i <= 2; i++) {
    t = Date.now();
    const r2 = await chat([{ role: 'user', content: question }]);
    a2.push(summarize(`A2 检索类问题 第${i}次（期望 tool_calls）`, r2, Date.now() - t));
  }
  const a2ok =
    a2.every((s) => s.calls.length > 0) &&
    a2.every((s) => /年假/.test(s.calls[0]?.function?.arguments ?? ''));
  console.log(`>>> A2 ${a2ok ? 'PASS' : 'FAIL'}`);

  // ---------- A3：工具结果回传，能续上（连跑 2 次） ----------
  const a3 = [];
  for (let i = 1; i <= 2; i++) {
    t = Date.now();
    const r3 = await chat([
      { role: 'user', content: question },
      {
        role: 'assistant',
        content: null,
        tool_calls: a2[0].calls, // 复用第 1 次的 tool_calls，避免回答内容漂移
      },
      {
        role: 'tool',
        tool_call_id: a2[0].calls[0].id,
        content:
          '[片段 1｜来源：星海科技员工手册.md 第 2 段]\n员工每年享有带薪年假 17 天，入职不满一年的按在职月份比例折算。',
      },
    ]);
    a3.push(summarize(`A3 结果回传 第${i}次（期望答案含 17）`, r3, Date.now() - t));
  }
  const a3ok = a3.every((s) => (s.msg.content ?? '').includes('17'));
  console.log(`>>> A3 ${a3ok ? 'PASS' : 'FAIL'}`);

  // ---------- A4 已隐含：以上全部带 thinking + temperature=0 ----------
  console.log(
    `\n>>> A4 ${a2ok && a3ok ? 'PASS（thinking disabled 与 tool calling 共存）' : 'FAIL'}`,
  );

  // ---------- D2：去掉 thinking 重跑 A2，观察参数交互 ----------
  t = Date.now();
  const r5 = await chat([{ role: 'user', content: question }], { withThinking: false });
  const s5 = summarize('D2 去掉 thinking（对照）', r5, Date.now() - t);
  console.log(`>>> D2 对照：tool_calls=${s5.calls.length > 0 ? '仍触发' : '未触发'}`);

    // ---------- D1：不带工具重跑 A2（反证：证明 A2 触发工具是因为工具存在） ----------
  t = Date.now();
  const r6 = await chat([{ role: 'user', content: question }], { tools: null });
  const s6 = summarize('D1 不带工具（反证，期望不出现 tool_calls）', r6, Date.now() - t);
  console.log(`>>> D1 反证：tool_calls=${s6.calls.length === 0 ? '0，PASS' : '仍出现，FAIL'}`);

}

main().catch((e) => {
  console.error('探针失败：', e.message);
  console.error('（若 A2 报 400/422 之类，先用 --model deepseek-chat 对照，区分脚本 bug 与模型限制）');
  process.exit(1);
});
