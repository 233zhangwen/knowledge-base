/**
 * 验证切片算法 —— 对应 docs/ACCEPTANCE-W3.md 的 A 组（A1/A2/A3/A4）。
 * 用法：node scripts/verify-chunk.mjs
 *
 * 为什么单独有个脚本：切片是纯函数、没有外部依赖，能在 1 秒内跑完，
 * 而同样的验证走 UI 要上传文件、等解析、再查库 —— 反馈慢十倍。
 * 能在本地秒验的东西，就不要塞进浏览器验收。
 *
 * ⚠️ 直接 import 真实的 src/lib/chunk.ts（不是复制一份逻辑过来测）：
 * 复制品测出来的是复制品的对错，源码改了它还绿，那就是假绿灯。
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const { splitText, CHUNK_SIZE, CHUNK_OVERLAP } = await import(
  pathToFileURL(path.resolve(process.cwd(), 'src/lib/chunk.ts')).href
);

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

// ---------- 造测试文本：3 段中文，约 1260 字 ----------
const SENTENCE = '这是一段用于测试切片算法的中文文本，它包含足够多的字符以便触发分块逻辑。';
const paragraphs = [SENTENCE.repeat(12), SENTENCE.repeat(12), SENTENCE.repeat(12)];
const doc = paragraphs.join('\n\n');

console.log('==============================================');
console.log(' 切片算法验证（A 组）');
console.log('==============================================');
console.log(`输入长度: ${doc.length} 字，参数: size=${CHUNK_SIZE} overlap=${CHUNK_OVERLAP}`);
console.log('');

// ---------- A1 块数与长度 ----------
console.log('【A1】块数与长度');
const chunks = splitText(doc);
console.log(`   块数: ${chunks.length}，各块长度: ${chunks.map((c) => c.length).join(', ')}`);

check(chunks.length >= 2, '块数 ≥ 2', `实际 ${chunks.length}`);
check(
  chunks.every((c) => c.length <= CHUNK_SIZE + CHUNK_OVERLAP),
  '每块不超过 size + overlap',
  `上限 ${CHUNK_SIZE + CHUNK_OVERLAP}`,
);
check(
  chunks.every((c) => c.length >= 250),
  '没有过短的碎片块',
  `最短 ${Math.min(...chunks.map((c) => c.length))}`,
);

// 无故碎片：相邻两块"去掉重叠后"仍塞得进一块，就说明该合并却没合并
const noWaste = chunks.slice(1).every((c, i) => {
  const prev = chunks[i];
  return prev.length + c.length - CHUNK_OVERLAP > CHUNK_SIZE;
});
check(noWaste, '相邻块之间没有"能合并却不合并"的碎片');

// ---------- A2 重叠生效 ----------
console.log('');
console.log('【A2】重叠生效');
if (chunks.length >= 2) {
  const tailOfFirst = chunks[0].slice(-CHUNK_OVERLAP);
  const headOfSecond = chunks[1].slice(0, CHUNK_OVERLAP);
  check(tailOfFirst === headOfSecond, '第 1 块末尾 80 字 === 第 2 块开头 80 字');
} else {
  check(false, '至少需要 2 块才能验重叠');
}

// ---------- A3 不丢字 ----------
console.log('');
console.log('【A3】不丢字（最重要）');
let rebuilt = chunks[0];
for (let i = 1; i < chunks.length; i++) {
  // 上一块（已含重叠）真正贡献给本块前缀的长度
  const tailLen = Math.min(CHUNK_OVERLAP, chunks[i - 1].length);
  rebuilt += chunks[i].slice(tailLen);
}
check(rebuilt.length === doc.length, '重建长度一致', `${rebuilt.length} vs ${doc.length}`);
check(rebuilt === doc, '重建内容与原文逐字符相等');

// ---------- A4 空输入与极短输入 ----------
console.log('');
console.log('【A4】空输入与极短输入');
let threw = false;
try {
  splitText('   ');
} catch (e) {
  threw = true;
  console.log(`   抛出的错误: ${e.message}`);
}
check(threw, '空白输入抛错（由上层转成 failed）');

const tiny = splitText('就这么五个字。');
check(tiny.length === 1, '极短文本输出 1 块', `实际 ${tiny.length} 块`);

// ---------- 额外观察：段落长度不均时的块数（A1 不钉死块数的原因） ----------
console.log('');
console.log('【观察】段落长度不均（200/200/800）时的块数：');
const uneven = [SENTENCE.repeat(6), SENTENCE.repeat(6), SENTENCE.repeat(23)].join('\n\n');
const unevenChunks = splitText(uneven);
console.log(`   输入 ${uneven.length} 字 → ${unevenChunks.length} 块，各块长度: ${unevenChunks.map((c) => c.length).join(', ')}`);
console.log('   （这一档不断言具体块数 —— 钉死数字会在代码正确时误报失败）');

console.log('');
console.log('==============================================');
console.log(failed === 0 ? ' ✅ A 组全部通过' : ` ❌ 有 ${failed} 项未通过`);
console.log('==============================================');
process.exit(failed === 0 ? 0 : 1);
