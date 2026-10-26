/**
 * 流协议解析器的边界测试。
 *
 * 为什么要为这么小的函数写脚本：它的坑全在浏览器里**构造不出来**的边界上 ——
 *   · citations 那行 JSON 正好被网络切成两半
 *   · 错误哨兵正好卡在两个数据块中间
 *   · 答案正文里本来就有换行（不能被当成协议的行分隔符）
 * 这些场景一旦出错，表现是"答案少了一段"或"引用全丢"，而且只在网络抖动时偶发。
 *
 * 跑法（Node 22.6+ 需要 --experimental-strip-types，Node 23+ 默认支持）：
 *   node --experimental-strip-types scripts/verify-stream-protocol.mts
 */
import {
  createCursor,
  encodeErrorLine,
  encodeHeadLine,
  feed,
  type Citation,
} from '../src/lib/chat-protocol.ts';

let failed = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n     期望 ${e}\n     实际 ${a}`}`);
}

const CITES: Citation[] = [
  {
    chunkIndex: 0,
    documentId: 'd1',
    documentTitle: '手册',
    similarity: 0.81,
    content: '第一段内容',
  },
  {
    chunkIndex: 3,
    documentId: 'd2',
    documentTitle: '报告',
    similarity: 0.62,
    content: '第二段内容',
  },
];

/** 把整条流按给定的切法喂进去，返回最终 cursor。 */
function run(chunks: string[]) {
  const cursor = createCursor();
  for (const c of chunks) feed(cursor, c);
  return cursor;
}

console.log('=== 1. 正常流：头一整块 + 正文分两块 ===');
{
  const c = run([encodeHeadLine({ citations: CITES, conversationId: 'conv-test' }), '答案是 ', '10 天。']);
  check('citations 条数', c.citations.length, 2);
  check('第 2 条的文档名', c.citations[1]?.documentTitle, '报告');
  // W5：会话 id 搭第一行回到前端（spec A5）。它丢了，用户刷新后就找不回这次会话。
  check('conversationId 透传', c.conversationId, 'conv-test');
  check('answer 拼接完整', c.answer, '答案是 10 天。');
  check('未进入错误态', c.errorMode, false);
}

console.log('\n=== 2. 头部被切成两半（JSON 跨块）===');
{
  const line = encodeHeadLine({ citations: CITES, conversationId: 'conv-test' });
  const cut = Math.floor(line.length / 2);
  const c = run([line.slice(0, cut), line.slice(cut), '正文']);
  check('跨块的 JSON 仍能解析', c.citations.length, 2);
  check('answer 不含头部残留', c.answer, '正文');
}

console.log('\n=== 3. 答案正文里有换行（不能被当行分隔符切）===');
{
  const c = run([encodeHeadLine({ citations: CITES, conversationId: 'conv-test' }), '第一段。\n\n第二段。\n']);
  check('换行原样保留', c.answer, '第一段。\n\n第二段。\n');
}

console.log('\n=== 4. 哨兵整块到达 ===');
{
  const c = run([encodeHeadLine({ citations: CITES, conversationId: 'conv-test' }), '已经生成的内容', encodeErrorLine('上游超时')]);
  // 哨兵行带一个前导 \n（为了让原始流肉眼可读），所以答案末尾会多一个换行，UI 上无害
  check('哨兵前的正文保留', c.answer, '已经生成的内容\n');
  check('错误消息', c.error, '上游超时');
  check('进入错误态', c.errorMode, true);
}

console.log('\n=== 5. 哨兵正好卡在两个数据块中间 ===');
{
  // 模拟 value 边界正好落在 \u0000 之前：把 encodeErrorLine 强行劈成两半
  const err = encodeErrorLine('生成到一半挂了');
  const nulAt = err.indexOf('\u0000');
  const c = run([encodeHeadLine({ citations: CITES, conversationId: 'conv-test' }), '半句答案', err.slice(0, nulAt), err.slice(nulAt)]);
  check('半句答案保留', c.answer, '半句答案\n');
  check('跨块的错误消息拼齐', c.error, '生成到一半挂了');
  check('进入错误态', c.errorMode, true);
}

console.log('\n=== 6. 一个字节一个字节喂（最极端的切法）===');
{
  const whole = encodeHeadLine({ citations: CITES, conversationId: 'conv-test' }) + '逐字喂入的答案。';
  const cursor = createCursor();
  for (const ch of whole) feed(cursor, ch);
  check('citations 仍解析成功', cursor.citations.length, 2);
  check('answer 一字不差', cursor.answer, '逐字喂入的答案。');
}

console.log('\n=== 7. 空召回：citations 为空数组 ===');
{
  const c = run([encodeHeadLine({ citations: [], conversationId: null }), '文档中没有相关内容。']);
  check('citations 为空', c.citations.length, 0);
  check('答案照常', c.answer, '文档中没有相关内容。');
}

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 条失败`);
process.exit(failed === 0 ? 0 : 1);
