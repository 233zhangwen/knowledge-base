/**
 * 流协议解析器的边界测试（**零依赖版**）。
 *
 * 为什么要为这么小的函数写脚本：它的坑全在浏览器里**构造不出来**的边界上 ——
 *   · citations 那行 JSON 正好被网络切成两半
 *   · 错误哨兵正好卡在两个数据块中间
 *   · 答案正文里本来就有换行（不能被当成协议的行分隔符）
 * 这些场景一旦出错，表现是"答案少了一段"或"引用全丢"，而且只在网络抖动时偶发。
 *
 * 跑法（Node 22.6+ 需要 --experimental-strip-types，Node 23+ 默认支持）：
 *   node --experimental-transform-types scripts/verify-stream-protocol.mts
 *
 * W12 之后用例本体搬到了 scripts/protocol-cases.mts —— 同一份数据
 * 也被 tests/unit/protocol.test.ts 引用（决策②-③）。这个脚本保留的意义：
 * **依赖装不上时仍然能验协议**（本仓库踩过两次 npm install 失败）。
 */
import { protocolCases } from './protocol-cases.mts';

let failed = 0;

for (const testCase of protocolCases) {
  console.log(`\n=== ${testCase.name} ===`);
  for (const { label, actual, expected } of testCase.checks()) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    const ok = a === e;
    if (!ok) failed++;
    console.log(`${ok ? '✅' : '❌'} ${label}${ok ? '' : `\n     期望 ${e}\n     实际 ${a}`}`);
  }
}

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 条失败`);
process.exit(failed === 0 ? 0 : 1);
