/**
 * 会话标题生成 + 相对时间分组。
 *
 * 这两块的共同点：**错了不报错，只是难看/难找**。
 * 标题截断错了 → 侧栏一列全一样长；分组错了 → 会话被塞进错误的那天下面。
 */
import { describe, expect, it } from 'vitest';

import { conversationTimeParts } from '@/lib/conversation-time';
import { titleFromQuestion } from '@/lib/history';

describe('titleFromQuestion', () => {
  it('短问题原样作标题', () => {
    expect(titleFromQuestion('年假有几天')).toBe('年假有几天');
  });

  it('超过 20 字截断加省略号', () => {
    const long = '正'.repeat(30);
    const title = titleFromQuestion(long);
    expect(title).toHaveLength(21); // 20 + '…'
    expect(title.endsWith('…')).toBe(true);
  });

  it('恰好 20 字不加省略号（闭合边界）', () => {
    const exact = '正'.repeat(20);
    expect(titleFromQuestion(exact)).toBe(exact);
  });

  it('换行和连续空白被压成单个空格（侧栏是一行布局）', () => {
    expect(titleFromQuestion('  年假\n\n有\t几天  ')).toBe('年假 有 几天');
  });

  it('空问题返回空串（调用方不写空标题，不会崩）', () => {
    expect(titleFromQuestion('   ')).toBe('');
  });
});

describe('conversationTimeParts', () => {
  const now = new Date(2026, 9, 30, 9, 0, 0); // 2026-10-30 09:00 本地时间

  it('同一天 → 今天', () => {
    expect(conversationTimeParts(new Date(2026, 9, 30, 0, 5), now)).toEqual({
      timeText: '今天',
      group: '今天',
    });
  });

  it('跨零点但只差 1 天 → 昨天（用自然日算，不是 24 小时）', () => {
    expect(conversationTimeParts(new Date(2026, 9, 29, 23, 59), now).timeText).toBe('昨天');
  });

  it('今年内更早 → M 月 D 日', () => {
    expect(conversationTimeParts(new Date(2026, 9, 27, 18, 0), now)).toEqual({
      timeText: '10 月 27 日',
      group: '10 月 27 日',
    });
  });

  it('跨年 → 带年份', () => {
    expect(conversationTimeParts(new Date(2025, 11, 31, 12, 0), now)).toEqual({
      timeText: '2025 年 12 月 31 日',
      group: '2025 年 12 月 31 日',
    });
  });

  it('未来时间（时钟漂移/时区错配）兜底成今天，不出现负数天', () => {
    expect(conversationTimeParts(new Date(2026, 10, 2, 8, 0), now).timeText).toBe('今天');
  });

  it('group 与 timeText 永远同源（分组的 Map key 依赖这一点）', () => {
    const samples = [
      new Date(2026, 9, 30),
      new Date(2026, 9, 29),
      new Date(2026, 8, 1),
      new Date(2024, 0, 1),
    ];
    for (const d of samples) {
      const { timeText, group } = conversationTimeParts(d, now);
      expect(group).toBe(timeText);
    }
  });
});
