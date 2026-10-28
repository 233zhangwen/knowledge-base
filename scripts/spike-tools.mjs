/**
 * W9 B 组 spike：用 Vercel AI SDK（ai@7 + @ai-sdk/openai@4）复现探针三条 case。
 * 目的：验证 AI SDK 路线在 DeepSeek 上可走通，为 C 组选型提供事实。
 *
 * 与 scripts/probe-tools.mjs 同源约束：同 endpoint / 同模型 / temperature=0 /
 * thinking disabled。thinking 不在 @ai-sdk/openai 的 providerOptions schema 里
 * （严格 zod，未知键被剥），用 createOpenAI 的 fetch 中间件注入 —— 见 INJECT。
 *
 * 用法：node scripts/spike-tools.mjs
 */
import { readFileSync } from 'node:fs';
import { generateText, tool, stepCountIs, jsonSchema } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

function loadEnv() {
  const env = {};
  for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)\s*$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const env = loadEnv();
const model = env.LLM_MODEL || 'deepseek-flash';

/**
 * fetch 中间件：给每个请求体注入 DeepSeek 私有的 thinking 参数。
 * 这是 @ai-sdk/openai 不认识第三方私有参数时的官方逃生门（settings 里的 fetch）。
 */
const INJECT = async (url, init) => {
  const body = JSON.parse(init.body);
  body.thinking = { type: 'disabled' };
  return fetch(url, { ...init, body: JSON.stringify(body) });
};

const deepseek = createOpenAI({
  baseURL: (env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
  apiKey: env.LLM_API_KEY,
  name: 'deepseek', // 3rd party provider：防止 SDK 按 openai 官方行为做特判
  fetch: INJECT,
});
const llm = deepseek(model);

/** 与探针同一个假工具：固定片段，只验证协议不评估质量 */
const retrieveKnowledge = tool({
  description:
    '从用户上传的文档知识库中检索与问题相关的原文片段。凡是可能和文档内容有关的问题（制度、流程、数字、条款），都必须先调用本工具，不要凭记忆回答。',
  inputSchema: jsonSchema({
    type: 'object',
    properties: { question: { type: 'string', description: '改写后的独立、完整的检索问句' } },
    required: ['question'],
  }),
  execute: async ({ question }) => {
    console.log(`  [tool 执行] retrieve_knowledge(question="${question}")`);
    return '[片段 1｜来源：星海科技员工手册.md 第 2 段]\n员工每年享有带薪年假 17 天，入职不满一年的按在职月份比例折算。';
  },
});

function report(tag, res, t0, expect) {
  const ms = Date.now() - t0;
  const text = res.text ?? '';
  const calls = res.toolCalls ?? [];
  const steps = res.steps?.length ?? 1;
  const md = (text.match(/\*\*|^#{1,3} /gm) ?? []).length;
  const ok = expect(text, calls, steps);
  console.log(`\n===== ${tag}（${ms}ms）`);
  console.log(`steps=${steps} toolCalls=${calls.length}`);
  console.log(`text: ${text.slice(0, 140) || '（空）'}`);
  console.log(`usage: prompt=${res.usage?.inputTokens} completion=${res.usage?.outputTokens}`);
  if (md > 0) console.log(`⚠️ markdown 痕迹 ×${md}（** 或 # 开头行）`);
  console.log(`>>> ${tag} ${ok ? 'PASS' : 'FAIL'}`);
  return ok;
}

async function main() {
  console.log(`ai@7 spike: model=${model} thinking=disabled(经 fetch 注入) temperature=0`);

  // B1：无关问题 → 不该调工具（对应探针 A1）
  let t = Date.now();
  const r1 = await generateText({
    model: llm,
    temperature: 0,
    tools: { retrieve_knowledge: retrieveKnowledge },
    prompt: '用一句话介绍你自己。',
  });
  const b1 = report('B1 无关问题（期望不调工具）', r1, t, (x, c) => c.length === 0);

  // B2：知识库问题 → 调工具并执行（对应探针 A2+A3 的多步合体）
  let t2 = Date.now();
  const r2 = await generateText({
    model: llm,
    temperature: 0,
    tools: { retrieve_knowledge: retrieveKnowledge },
    stopWhen: stepCountIs(5), // 多步上限：工具→结果→续答 一轮够用，5 步封顶防失控
    prompt: '星海科技带薪年假有几天？',
  });
  const b2 = report(
    'B2 多步：调工具→执行→续答（期望 answer 含 17）',
    r2,
    t2,
    (x, c, s) => c.length > 0 && s >= 2 && x.includes('17'),
  );

  console.log(`\n===== 总结：B1=${b1 ? 'PASS' : 'FAIL'} B2=${b2 ? 'PASS' : 'FAIL'}`);
  console.log('（ai@7 + @ai-sdk/openai@4 在 DeepSeek 上的协议验证完成）');
}

main().catch((e) => {
  console.error('spike 失败：', e.message);
  if (e.responseBody) console.error('response:', String(e.responseBody).slice(0, 300));
  process.exit(1);
});
