/**
 * 切片（chunk）的边界测试。
 *
 * 为什么这段最需要测试：它的输出直接决定检索命中率，但**改坏了完全不报错** ——
 * 切片变碎 → 向量数量暴涨、每个块信息量不足 → 检索变差，表现只是"答得没以前准"。
 * W3 踩过的最典型坑是"丢字"（分隔符被 split 吃掉），那种 bug 只有对比原文才看得出来。
 */
import { describe, expect, it } from 'vitest';

import { CHUNK_OVERLAP, CHUNK_SIZE, splitText } from '@/lib/chunk';

const UPPER_BOUND = CHUNK_SIZE + CHUNK_OVERLAP;

describe('splitText · 输入校验', () => {
  it('空串抛错（调用方要转成文档 failed 状态）', () => {
    expect(() => splitText('')).toThrow('文档内容为空');
  });

  it('只有空白也算空', () => {
    expect(() => splitText('   \n\n \t ')).toThrow('文档内容为空');
  });
});

describe('splitText · 基本切分', () => {
  it('短文本原样返回一块', () => {
    expect(splitText('年假 17 天。')).toEqual(['年假 17 天。']);
  });

  it('恰好 CHUNK_SIZE 字：不切成两块', () => {
    const text = '甲'.repeat(CHUNK_SIZE);
    const chunks = splitText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(CHUNK_SIZE);
  });

  it('CRLF 被统一成 LF（否则 Windows 上传的文档会多出一堆 \\r）', () => {
    const chunks = splitText('第一行\r\n第二行\r第三行');
    expect(chunks[0]).not.toContain('\r');
    expect(chunks[0]).toContain('第一行\n第二行\n第三行');
  });
});

describe('splitText · 边界与保真', () => {
  it('超长且无任何标点：硬切兜底，不许死循环', () => {
    const text = '乙'.repeat(CHUNK_SIZE * 3 + 17);
    const chunks = splitText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // 加了重叠后单块上限是 CHUNK_SIZE + CHUNK_OVERLAP
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(UPPER_BOUND);
  });

  it('段落切成多块后，首块保持原文开头（不丢字）', () => {
    const paragraph = '这是一段用来测试切片的文字，'.repeat(30); // ~480 字 × 3 段
    const text = [paragraph, paragraph, paragraph].join('\n\n');
    const chunks = splitText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].startsWith('这是一段用来测试切片的文字')).toBe(true);
  });

  it('相邻块之间有重叠：第 2 块开头是第 1 块结尾的一段', () => {
    const paragraph = '丙'.repeat(400);
    const chunks = splitText(`${paragraph}\n\n${paragraph}\n\n${paragraph}`);
    expect(chunks.length).toBeGreaterThan(1);
    const tailOfFirst = chunks[0].slice(-CHUNK_OVERLAP);
    expect(chunks[1].startsWith(tailOfFirst)).toBe(true);
  });
});
