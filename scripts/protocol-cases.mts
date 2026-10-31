/**
 * 协议解析的边界用例 —— **一份数据，两个 runner**（W12 决策②-③）。
 *
 * 为什么要把用例抽成"数据"而不是直接写成 vitest 的 it()：
 *   这个仓库两次踩过「npm install 装不上」的坑（见工作日志 2026-10-23）。
 *   如果协议验证只能靠 vitest 跑，那么在依赖装不上的那一天，
 *   最需要验尸的时刻反而验不了 —— 而这几个函数的 bug 表现恰好是
 *   "答案少一段 / 引用全丢"，只在网络抖动时偶发，是最需要随时能验的东西。
 *
 * 所以：
 *   · scripts/verify-stream-protocol.mts  → 零依赖，node --experimental-transform-types 直接跑
 *   · tests/unit/protocol.test.ts         → vitest，进 CI、进 watch、有报告
 * 两边 import 同一份 protocolCases，断言不会漂。
 *
 * 每个 case 的 checks() 返回 [标签, 实际值, 期望值] 三元组，
 * 不传 expect 进来 —— 让这个文件保持零依赖（不 import vitest）。
 */
import {
  createCursor,
  createCursorV2,
  encodeCitationsLine,
  encodeErrorLine,
  encodeHeadLine,
  encodeHeadLineV2,
  encodeToolLine,
  feed,
  feedV2,
  TEXT_START,
  type Citation,
} from '../src/lib/chat-protocol.ts';

export type ProtocolCheck = {
  label: string;
  actual: unknown;
  expected: unknown;
};

export type ProtocolCase = {
  name: string;
  checks: () => ProtocolCheck[];
};

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

export const protocolCases: ProtocolCase[] = [
  {
    name: '1. 正常流：头一整块 + 正文分两块',
    checks: () => {
      const c = run([
        encodeHeadLine({ citations: CITES, conversationId: 'conv-test' }),
        '答案是 ',
        '10 天。',
      ]);
      return [
        { label: 'citations 条数', actual: c.citations.length, expected: 2 },
        { label: '第 2 条的文档名', actual: c.citations[1]?.documentTitle, expected: '报告' },
        // W5：会话 id 搭第一行回到前端（spec A5）。它丢了，用户刷新后就找不回这次会话。
        { label: 'conversationId 透传', actual: c.conversationId, expected: 'conv-test' },
        { label: 'answer 拼接完整', actual: c.answer, expected: '答案是 10 天。' },
        { label: '未进入错误态', actual: c.errorMode, expected: false },
      ];
    },
  },
  {
    name: '2. 头部被切成两半（JSON 跨块）',
    checks: () => {
      const line = encodeHeadLine({ citations: CITES, conversationId: 'conv-test' });
      const cut = Math.floor(line.length / 2);
      const c = run([line.slice(0, cut), line.slice(cut), '正文']);
      return [
        { label: '跨块的 JSON 仍能解析', actual: c.citations.length, expected: 2 },
        { label: 'answer 不含头部残留', actual: c.answer, expected: '正文' },
      ];
    },
  },
  {
    name: '3. 答案正文里有换行（不能被当行分隔符切）',
    checks: () => {
      const c = run([
        encodeHeadLine({ citations: CITES, conversationId: 'conv-test' }),
        '第一段。\n\n第二段。\n',
      ]);
      return [{ label: '换行原样保留', actual: c.answer, expected: '第一段。\n\n第二段。\n' }];
    },
  },
  {
    name: '4. 哨兵整块到达',
    checks: () => {
      const c = run([
        encodeHeadLine({ citations: CITES, conversationId: 'conv-test' }),
        '已经生成的内容',
        encodeErrorLine('上游超时'),
      ]);
      return [
        // 哨兵行带一个前导 \n（为了让原始流肉眼可读），所以答案末尾会多一个换行，UI 上无害
        { label: '哨兵前的正文保留', actual: c.answer, expected: '已经生成的内容\n' },
        { label: '错误消息', actual: c.error, expected: '上游超时' },
        { label: '进入错误态', actual: c.errorMode, expected: true },
      ];
    },
  },
  {
    name: '5. 哨兵正好卡在两个数据块中间',
    checks: () => {
      // 模拟 value 边界正好落在 \u0000 之前：把 encodeErrorLine 强行劈成两半
      const err = encodeErrorLine('生成到一半挂了');
      const nulAt = err.indexOf('\u0000');
      const c = run([
        encodeHeadLine({ citations: CITES, conversationId: 'conv-test' }),
        '半句答案',
        err.slice(0, nulAt),
        err.slice(nulAt),
      ]);
      return [
        { label: '半句答案保留', actual: c.answer, expected: '半句答案\n' },
        { label: '跨块的错误消息拼齐', actual: c.error, expected: '生成到一半挂了' },
        { label: '进入错误态', actual: c.errorMode, expected: true },
      ];
    },
  },
  {
    name: '6. 一个字节一个字节喂（最极端的切法）',
    checks: () => {
      const whole =
        encodeHeadLine({ citations: CITES, conversationId: 'conv-test' }) + '逐字喂入的答案。';
      const cursor = createCursor();
      for (const ch of whole) feed(cursor, ch);
      return [
        { label: 'citations 仍解析成功', actual: cursor.citations.length, expected: 2 },
        { label: 'answer 一字不差', actual: cursor.answer, expected: '逐字喂入的答案。' },
      ];
    },
  },
  {
    name: '7. 空召回：citations 为空数组',
    checks: () => {
      const c = run([
        encodeHeadLine({ citations: [], conversationId: null }),
        '文档中没有相关内容。',
      ]);
      return [
        { label: 'citations 为空', actual: c.citations.length, expected: 0 },
        { label: '答案照常', actual: c.answer, expected: '文档中没有相关内容。' },
      ];
    },
  },
  {
    name: '8. v2：无事件流（闲聊，2026-10-28 bug 的回归用例）',
    checks: () => {
      // 实测 bug：闲聊不触发工具 → 服务端第一行后直接发文本，
      // 旧 feedV2 靠"找 \n 逐行猜边界"，没有换行的答案全被扣在 lineBuf，前端空白到刷新。
      const chunks = [encodeHeadLineV2('conv-1'), TEXT_START, '你好！有什么', '可以帮您？'];
      const c = createCursorV2();
      for (const chunk of chunks) feedV2(c, chunk);
      return [
        { label: 'v2 无换行答案完整累积', actual: c.answer, expected: '你好！有什么可以帮您？' },
        { label: 'v2 无引用', actual: c.citations.length, expected: 0 },
        { label: 'v2 会话 id', actual: c.conversationId, expected: 'conv-1' },
      ];
    },
  },
  {
    name: '9. v2：事件行 + 哨兵 + 文本（完整事件流，每 7 字符乱切）',
    checks: () => {
      const whole =
        encodeHeadLineV2('conv-2') +
        encodeToolLine('星海科技 年假') +
        encodeCitationsLine(CITES) +
        TEXT_START +
        '根据手册，年假 17 天。';
      const c = createCursorV2();
      for (let i = 0; i < whole.length; i += 7) feedV2(c, whole.slice(i, i + 7));
      return [
        { label: 'v2 工具问题', actual: c.toolQuestion, expected: '星海科技 年假' },
        { label: 'v2 citations 解析', actual: c.citations.length, expected: 2 },
        { label: 'v2 文本不含哨兵', actual: c.answer, expected: '根据手册，年假 17 天。' },
        { label: 'v2 会话 id', actual: c.conversationId, expected: 'conv-2' },
      ];
    },
  },
  {
    name: '10. v2：事件阶段就出错（\\u0000 在哨兵前到达）',
    checks: () => {
      const c = createCursorV2();
      feedV2(c, encodeHeadLineV2('conv-3'));
      feedV2(c, encodeToolLine('测试问题') + encodeErrorLine('embedding 挂了'));
      return [
        { label: 'v2 错误态', actual: c.errorMode, expected: true },
        { label: 'v2 错误消息', actual: c.error.trim(), expected: 'embedding 挂了' },
      ];
    },
  },
  {
    name: '11. v2：哨兵和文本边界跨块',
    checks: () => {
      const whole = encodeHeadLineV2('conv-4') + TEXT_START + '答案正文';
      const cut = whole.indexOf(TEXT_START) + 1; // 哨兵是上一块的最后一个字符
      const c = createCursorV2();
      feedV2(c, whole.slice(0, cut));
      feedV2(c, whole.slice(cut));
      return [{ label: 'v2 跨块后文本完整', actual: c.answer, expected: '答案正文' }];
    },
  },
];
