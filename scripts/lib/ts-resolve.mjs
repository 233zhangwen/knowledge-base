/**
 * Node ESM 解析钩子：让「无扩展名的相对导入」能找到 .ts 文件。
 *
 * 为什么需要它：
 *   TS 源码里写 `import { embedTexts } from './embedding'`（不带后缀），
 *   这是 TS 与打包器的惯例；但 Node 的 ESM 规范**要求必须带扩展名**，
 *   直接 `node --experimental-transform-types script.mts` 会在
 *   `import '../src/lib/retrieve.ts'` 的下一跳炸掉。
 *
 * 为什么不能用「生成一份补了后缀的副本」绕过（W15 的老办法）：
 *   副本一旦落地，评测跑的就是**副本**而不是生产代码。副本会随时间漂移 ——
 *   这正是 W16 A0 要消灭的病根（`eval-agent.mjs` 里手抄的 searchChunks
 *   漏了 rerank 和 W14 的围栏，等于评测了一个线上不存在的系统，还评了半年）。
 *
 * 所以在解析层解决，源码一个字不动：解析失败时按 .ts / .tsx / index.ts 依次重试。
 * 它只在 node 直跑脚本时生效（`--import` 注册），**不影响 Next 构建**。
 */

const CANDIDATE_SUFFIXES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

/**
 * JSON 的加载钩子。
 *
 * 生产代码里写的是 `import PROMPT from './agent-prompt.json'`（打包器惯例，不需要 attributes），
 * 但 Node 的 ESM 规范要求 `with { type: 'json' }`，否则直接报
 * ERR_IMPORT_ATTRIBUTE_MISSING。给源码加 attributes 又会牵连 Next 构建，
 * 所以在加载层把它转成一个普通的 ES 模块：`export default <json>`。
 *
 * 只处理项目内的 .json —— node_modules 里的 json（package.json 等）走 CJS 解析，
 * 拦截它们会把依赖打坏。
 */
export async function load(url, context, nextLoad) {
  if (url.endsWith('.json') && !url.includes('/node_modules/')) {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(new URL(url), 'utf8');
    return { format: 'module', source: `export default ${raw};`, shortCircuit: true };
  }
  return nextLoad(url, context);
}


export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    // 只处理相对导入，别去猜裸包名（'ai' / 'pg' 走的是正常的 node_modules 解析）
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
    if (!isRelative) throw err;

    // 已经带扩展名的（.json / .ts / .mjs）说明原样就是对的，别乱补
    if (/\.[a-z0-9]+$/i.test(specifier)) throw err;

    for (const suffix of CANDIDATE_SUFFIXES) {
      try {
        return await nextResolve(specifier + suffix, context);
      } catch {
        // 换下一个后缀
      }
    }
    throw err; // 全部失败 → 抛原始错误，保留最准确的报错位置
  }
}
