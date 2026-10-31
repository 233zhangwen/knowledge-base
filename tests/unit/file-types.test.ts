/**
 * 文件类型识别 / 存储 key 生成。
 *
 * 这两块是**安全边界**：detectSourceType 决定解析器走哪条路（认错就走错解析器，
 * 报错信息还很难懂）；buildStorageKey 的文件名部分是用户可控输入，
 * 净化漏一个字符就是路径穿越。
 */
import { describe, expect, it } from 'vitest';

import { buildStorageKey, contentTypeFor, detectSourceType } from '@/lib/file-types';

describe('detectSourceType', () => {
  it('认常见后缀', () => {
    expect(detectSourceType('手册.md')).toBe('md');
    expect(detectSourceType('报告.txt')).toBe('txt');
    expect(detectSourceType('规范.pdf')).toBe('pdf');
  });

  it('大小写不敏感', () => {
    expect(detectSourceType('README.MD')).toBe('md');
    expect(detectSourceType('A.PdF')).toBe('pdf');
  });

  it('不支持的类型返回 null（由调用方转成用户可读的错误）', () => {
    expect(detectSourceType('简历.docx')).toBeNull();
    expect(detectSourceType('图.png')).toBeNull();
  });

  it('没有后缀返回 null', () => {
    expect(detectSourceType('README')).toBeNull();
  });
});

describe('contentTypeFor', () => {
  it('三种类型都带 charset（中文不乱码的前提）', () => {
    expect(contentTypeFor('pdf')).toBe('application/pdf');
    expect(contentTypeFor('md')).toContain('charset=utf-8');
    expect(contentTypeFor('txt')).toContain('charset=utf-8');
  });
});

describe('buildStorageKey', () => {
  it('结构是 userId/documentId-安全文件名', () => {
    expect(buildStorageKey('u1', 'd1', '手册.md')).toBe('u1/d1-手册.md');
  });

  it('路径分隔符被替换：不能靠文件名跳出自己的前缀目录', () => {
    const key = buildStorageKey('u1', 'd1', '../evil/../x.md');
    // 除了 userId/ 与 documentId- 之间那一个分隔符，不允许再出现斜杠
    expect(key.split('/')).toHaveLength(2);
    expect(key.startsWith('u1/d1-')).toBe(true);
  });

  it('开头的点被去掉（避免隐藏文件语义）', () => {
    const key = buildStorageKey('u1', 'd1', '.env');
    const name = key.slice('u1/d1-'.length);
    expect(name.startsWith('.')).toBe(false);
  });

  it('超长文件名被截断到 80 字符', () => {
    const key = buildStorageKey('u1', 'd1', `${'长'.repeat(200)}.md`);
    const name = key.slice('u1/d1-'.length);
    expect(name.length).toBeLessThanOrEqual(80);
  });

  it('空文件名兜底成 unnamed', () => {
    expect(buildStorageKey('u1', 'd1', '')).toBe('u1/d1-unnamed');
    expect(buildStorageKey('u1', 'd1', '   ')).toBe('u1/d1-unnamed');
  });
});
