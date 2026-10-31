/**
 * buildRagMessages：把「历史 + 问题 + 检索片段」拼成 LLM 消息。
 *
 * 这里出错的方式特别隐蔽：
 *   · 编号和引用数组错位 → 引用张冠李戴，看起来"有引用"，其实全错；
 *   · 历史插到问题后面 → 代词追问全失效，模型只能"看着答案猜问题"；
 *   · 空召回不给硬话 → 模型自行发挥，RAG 变成"带参考书的闲聊"。
 * 三种都不会抛异常，只会让答案慢慢变差。所以必须钉死。
 */
import { describe, expect, it } from 'vitest';

import { buildRagMessages } from '@/lib/llm';
import type { RetrievedChunk } from '@/lib/retrieve';

function chunk(over: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    id: 'c1',
    content: '年假为 17 天。',
    chunkIndex: 0,
    documentId: 'd1',
    documentTitle: '员工手册',
    similarity: 0.9,
    suspicious: false,
    ...over,
  };
}

describe('buildRagMessages · 结构', () => {
  it('system 在最前，用户问题在最后，历史夹中间', () => {
    const messages = buildRagMessages('年假几天', [chunk()], [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，请问想了解什么？' },
    ]);

    expect(messages[0].role).toBe('system');
    expect(messages.at(-1)?.role).toBe('user');
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messages[1].content).toBe('你好');
  });

  it('没有历史时只有两条消息', () => {
    expect(buildRagMessages('年假几天', [chunk()])).toHaveLength(2);
  });
});

describe('buildRagMessages · 引用编号', () => {
  it('片段编号从 1 起、与数组顺序一致（前端 citations[i] 就靠它对齐）', () => {
    const messages = buildRagMessages('对比一下', [
      chunk({ id: 'c1', documentTitle: '手册A' }),
      chunk({ id: 'c2', documentTitle: '手册B', chunkIndex: 4, content: '年假 20 天。' }),
    ]);
    const userContent = messages.at(-1)!.content;

    expect(userContent).toContain('<<<DOC [1] 《手册A》第 1 段>>>');
    expect(userContent).toContain('<<<DOC [2] 《手册B》第 5 段>>>');
    // 每个资料块都必须闭合：开了不关，模型会把后面的问题也当成资料
    expect(userContent.match(/<<<END DOC>>>/g)).toHaveLength(2);
    // citationRule 的 {max} 必须等于实际条数
    expect(messages[0].content).toContain('[1] 到 [2]');
  });

  it('一条片段都不召回时，硬话写进 system，且用户消息里是"没有参考资料"', () => {
    const messages = buildRagMessages('年假几天', []);
    expect(messages[0].content).toContain('本次没有提供任何参考资料');
    expect(messages[0].content).not.toContain('只允许引用实际提供的编号');
    expect(messages.at(-1)!.content).toContain('本次没有检索到任何参考资料');
  });

  it('有历史时追加"代词追问"规则，没有时不加（少一条规则 = 少一分注意力稀释）', () => {
    const withoutHistory = buildRagMessages('年假几天', [chunk()]);
    const withHistory = buildRagMessages('那第二年呢', [chunk()], [
      { role: 'user', content: '年假几天' },
      { role: 'assistant', content: '17 天。[1]' },
    ]);
    expect(withoutHistory[0].content).not.toContain('代词');
    expect(withHistory[0].content).toContain('代词');
  });

  it('规则编号是动态的：有引用规则时编号连续、不重复', () => {
    const system = buildRagMessages('年假几天', [chunk()])[0].content;
    const numbers = [...system.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6]); // 5 条固定规则（W14 加了围栏那条）+ 1 条引用规则
  });
});

describe('buildRagMessages · 注入防护', () => {
  it('片段内容里的 {question} 字面量不会被二次替换', () => {
    const messages = buildRagMessages('真正的问题', [
      chunk({ content: '文档里写着 {question} 这个占位符。' }),
    ]);
    const userContent = messages.at(-1)!.content;
    expect(userContent).toContain('文档里写着 {question} 这个占位符。');
    expect(userContent.endsWith('问题：真正的问题')).toBe(true);
  });
});
