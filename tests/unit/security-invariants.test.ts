/**
 * 安全不变量：用测试钉住"今天安全"这件事。
 *
 * 为什么值得单开一个文件：这些断言不看业务逻辑，只看**代码形态**。
 * 它们防的不是"现在有 bug"，而是"某次重构顺手加了一个洞"——
 * 比如为了渲染 markdown 引入 dangerouslySetInnerHTML，
 * 而模型输出的内容里恰好包含用户上传文档的原文（= 攻击者可控的 HTML）。
 *
 * 代价很低（读几十个文件，毫秒级），收益是把这个决定从"我记得"变成"CI 记得"。
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = path.join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'generated') continue; // Prisma 产物不参与
      walk(full, out);
    } else if (/\.(tsx?|mts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC);

describe('安全不变量 · 渲染层', () => {
  it('src 下不存在 dangerouslySetInnerHTML（模型输出 + 文档原文都是不可信内容）', () => {
    const hits = files.filter((f) => fs.readFileSync(f, 'utf8').includes('dangerouslySetInnerHTML'));
    expect(hits).toEqual([]);
  });
});

describe('安全不变量 · 数据层', () => {
  it('检索 SQL 必须带 kbId 过滤（跨库泄漏是静默事故，W4 A1）', () => {
    const source = fs.readFileSync(path.join(SRC, 'lib', 'retrieve.ts'), 'utf8');
    expect(source).toContain('d."kbId" = ${kbId}');
    expect(source).toContain("d.status = 'ready'");
  });

  it('检索工具的参数里没有 kbId（模型不能指定库，W10 D2 反证）', () => {
    const source = fs.readFileSync(path.join(SRC, 'lib', 'agent-llm.ts'), 'utf8');
    // 工具 schema 只允许 question 一个字段
    expect(source).toContain('required: [\'question\']');
    expect(source).not.toMatch(/properties:\s*{[^}]*kbId/);
  });
});
