/**
 * 结构化日志的单测（W13 B 组）。
 *
 * 这三类断言对应的都是"写错了不会报错、只会在线上某天发现日志没法用"的地方：
 *   ① 分级过滤装反（LOG_LEVEL=error 却什么都打）
 *   ② 敏感字段没被替换（密钥进了日志平台）
 *   ③ JSON 形状变了（平台按 evt 过滤时一条也搜不到）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { log, previewText } from '@/lib/log';

/** 抓 console.log/warn/error 的输出；每条都是一行 JSON 字符串 */
function captureConsole() {
  const lines: { level: string; text: string }[] = [];
  const push = (level: string) => (msg: unknown) => {
    lines.push({ level, text: String(msg) });
  };
  vi.spyOn(console, 'log').mockImplementation(push('log'));
  vi.spyOn(console, 'warn').mockImplementation(push('warn'));
  vi.spyOn(console, 'error').mockImplementation(push('error'));
  return lines;
}

const ORIGINAL = process.env.LOG_LEVEL;

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = ORIGINAL;
});

describe('log 分级', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('默认 info：info 打、debug 不打', () => {
    delete process.env.LOG_LEVEL;
    const lines = captureConsole();

    log.debug('x.debug');
    log.info('x.info');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0].text).evt).toBe('x.info');
  });

  it('LOG_LEVEL=error 时 info/warn 全部静默，只有 error 出去', () => {
    process.env.LOG_LEVEL = 'error';
    const lines = captureConsole();

    log.info('x.info');
    log.warn('x.warn');
    log.error('x.error');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0].text).lvl).toBe('error');
  });

  it('LOG_LEVEL=debug 时 debug 也出来', () => {
    process.env.LOG_LEVEL = 'debug';
    const lines = captureConsole();

    log.debug('x.debug');

    expect(lines).toHaveLength(1);
  });

  it('error 级走 console.error（平台按 stderr 分流），其余走 console.log', () => {
    delete process.env.LOG_LEVEL;
    const lines = captureConsole();

    log.error('x.error');
    log.warn('x.warn');

    expect(lines.map((l) => l.level)).toEqual(['error', 'warn']);
  });
});

describe('log 输出形状', () => {
  beforeEach(() => {
    delete process.env.LOG_LEVEL;
    vi.restoreAllMocks();
  });

  it('单行 JSON，字段是 t / lvl / evt + 自定义', () => {
    const lines = captureConsole();

    log.info('agent.turn.done', { steps: 3, ok: true });

    const parsed = JSON.parse(lines[0].text);
    expect(Object.keys(parsed).sort()).toEqual(['evt', 'lvl', 'ok', 'steps', 't']);
    expect(parsed.t).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('敏感字段名一律 [redacted]', () => {
    const lines = captureConsole();

    log.info('x', { apiKey: 'sk-123', AUTH_SECRET: 'abc', cookie: 'c', steps: 1 });

    const parsed = JSON.parse(lines[0].text);
    expect(parsed.apiKey).toBe('[redacted]');
    expect(parsed.AUTH_SECRET).toBe('[redacted]');
    expect(parsed.cookie).toBe('[redacted]');
    expect(parsed.steps).toBe(1);
  });

  it('Error 对象被拆成 err + stack，不是空对象', () => {
    const lines = captureConsole();

    log.error('x', { error: new Error('boom') });

    const parsed = JSON.parse(lines[0].text);
    expect(parsed.err).toBe('boom');
    expect(parsed.stack).toContain('boom');
  });

  it('超长字符串被截断（正文类内容不该整段进日志）', () => {
    const lines = captureConsole();

    log.info('x', { note: 'a'.repeat(500) });

    const parsed = JSON.parse(lines[0].text);
    expect(parsed.note.length).toBeLessThan(260);
    expect(parsed.note).toContain('(500)');
  });

  it('undefined 字段被丢掉（不产生 "key":undefined 的脏 JSON）', () => {
    const lines = captureConsole();

    log.info('x', { a: undefined, b: 1 });

    expect(JSON.parse(lines[0].text)).not.toHaveProperty('a');
  });
});

describe('previewText', () => {
  it('同输入同输出，不同输入不同指纹', () => {
    expect(previewText('你好')).toBe(previewText('你好'));
    expect(previewText('你好')).not.toBe(previewText('你好吗'));
  });

  it('不含原文（只留长度与 sha1 前 8 位）', () => {
    const preview = previewText('正式员工年假有多少天？');
    expect(preview).not.toContain('年假');
    expect(preview).toMatch(/^\d+字#[0-9a-f]{8}$/);
  });
});
