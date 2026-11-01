import { describe, expect, it } from 'vitest';

import {
  alignTitle,
  extractDocMeta,
  fenceMetaLabel,
  normalizeTitle,
  resolveMetas,
  statusOf,
  type DocMetaRow,
} from '../../src/lib/doc-meta';

/**
 * W17 的元数据抽取与对齐。
 *
 * 这一组测试守的是「宁可漏判，不可误判」：
 *   漏判 → 元数据那一行为空，模型回到今天的水平（自己追废止声明）
 *   误判 → 模型主动说出"这份已废止"，而它其实是现行版 —— 主动误导
 * 所以每个「不该命中」的用例，和「该命中」的一样重要。
 */

const H = (s: string) => s.replace(/^\n/, '');

describe('extractDocMeta · 生效日期', () => {
  it('公文头路径（E/F/G/H/I 的形态）', () => {
    const m = extractDocMeta(
      H(`
# 星海科技员工手册（2024 版）

> 文件编号：XH-HR-2024-007
> 生效日期：2024 年 1 月 1 日
> 归口部门：人力资源部
`),
    );
    expect(m.effectiveFromSource).toBe('header');
    expect(m.effectiveFrom).toBe('2024-01-01');
    expect(m.docTitle).toBe('星海科技员工手册（2024 版）');
  });

  it('正文句路径（C 的真实形态：没有公文头）', () => {
    const m = extractDocMeta(
      H(`
# 星海科技员工手册（2026 完整版）

## 十二、附则

本手册自 2026 年 1 月 1 日起施行，此前发布的《员工手册（2024 版）》同时废止。
`),
    );
    expect(m.effectiveFromSource).toBe('body');
    expect(m.effectiveFrom).toBe('2026-01-01');
  });

  it('两条路径都没有 → null，且 source 是 none（不能瞎猜）', () => {
    const m = extractDocMeta('# 某制度\n\n正文没有任何日期。\n');
    expect(m.effectiveFrom).toBeNull();
    expect(m.effectiveFromSource).toBe('none');
  });

  it('公文头写坏了的日期要留痕，而不是静默降级到正文', () => {
    // 中文数字日期：当前不支持，必须显式报出来，否则会被当成"文件头没写"
    const m = extractDocMeta(
      H(`
# 某制度
> 生效日期：二〇二六年三月一日
本制度自 2026 年 3 月 1 日起施行。
`),
    );
    expect(m.warnings.some((w) => w.includes('解析失败'))).toBe(true);
    expect(m.effectiveFromSource).toBe('body'); // 兜底仍然工作
  });

  it('公文头与正文日期不一致 → 留痕，且以公文头为准', () => {
    const m = extractDocMeta(
      H(`
# 某制度
> 生效日期：2026 年 1 月 1 日
本制度自 2026 年 2 月 1 日起施行。
`),
    );
    expect(m.effectiveFromSource).toBe('header');
    expect(m.effectiveFrom).toBe('2026-01-01');
    expect(m.warnings.some((w) => w.includes('不一致'))).toBe(true);
  });

  it('2 月 30 日这种不存在的日期被判为无效，而不是滚动到 3 月', () => {
    const m = extractDocMeta('# X\n> 生效日期：2026 年 2 月 30 日\n');
    expect(m.effectiveFrom).toBeNull();
    expect(m.warnings.length).toBeGreaterThan(0);
  });

  it('「自审批通过次月起执行」这种无具体日期的句子不产生日期', () => {
    const m = extractDocMeta('# I\n转正后的薪酬自审批通过次月起执行。\n');
    expect(m.effectiveFrom).toBeNull();
  });
});

describe('extractDocMeta · 废止关系', () => {
  it('后置写法：`《X》同时废止`', () => {
    const m = extractDocMeta('# X\n本手册自 2026 年 1 月 1 日起施行，此前发布的《员工手册（2024 版）》同时废止。\n');
    expect(m.supersedesRaw).toEqual(['员工手册（2024版）']);
  });

  it('前置写法：`废止《X》`', () => {
    const m = extractDocMeta('# X\n本办法施行后废止《旧办法》。\n');
    expect(m.supersedesRaw).toEqual(['旧办法']);
  });

  it('⚠️「12 月 31 日自动失效」不是文档废止', () => {
    // E 文档第 40 行的真实句子：讲的是额度到期，不是文件作废
    const m = extractDocMeta('# X\n上述额度均不得跨年结转，未使用部分在 12 月 31 日自动失效。\n');
    expect(m.supersedesRaw).toEqual([]);
  });

  it('⚠️「以本制度为准」是适用范围声明，不是废止声明', () => {
    // F 文档第 94 行的真实句子：从书名号到句末 26 个字，超出窗口
    const m = extractDocMeta(
      '# F\n母公司《员工手册》与本制度不一致的，在成都研发中心范围内以本制度为准。\n',
    );
    expect(m.supersedesRaw).toEqual([]);
  });

  it('一句话里两个日期 + 一个废止目标要正确配对', () => {
    const m = extractDocMeta(
      '# X\n本手册自 2024 年 1 月 1 日起施行，此前发布的《员工手册（2021 版）》同时废止。\n',
    );
    expect(m.effectiveFrom).toBe('2024-01-01'); // 不是 2021
    expect(m.supersedesRaw).toEqual(['员工手册（2021版）']);
  });

  it('并列废止多个文件时全都要收（第一版正则只抓到第一个）', () => {
    const m = extractDocMeta('# X\n原《甲办法》《乙规定》同时废止。\n');
    expect(m.supersedesRaw).toEqual(['甲办法', '乙规定']);
  });

  it('「依据《甲》制定本办法，原《乙》同时废止」只收被废止的那个', () => {
    // 两个书名号在同一句，第一个是依据，不是废止目标
    const m = extractDocMeta('# X\n本办法依据《公司章程》制定，原《差旅细则》同时废止。\n');
    expect(m.supersedesRaw).toEqual(['差旅细则']);
  });

  it('跨句不串味：上一句的书名号不会被下一句的废止词牵连', () => {
    const m = extractDocMeta('# X\n本制度依据《公司章程》制定。\n原《旧制度》同时废止。\n');
    expect(m.supersedesRaw).toEqual(['旧制度']);
  });
});

describe('normalizeTitle', () => {
  it('去掉文件名前缀与扩展名', () => {
    expect(normalizeTitle('E-星海科技员工手册(2024版).md')).toBe('星海科技员工手册2024版');
  });

  it('全角括号与半角括号归一', () => {
    expect(normalizeTitle('员工手册（2024 版）')).toBe(normalizeTitle('员工手册(2024版)'));
  });

  it('书名号、空白、连接符全去掉', () => {
    expect(normalizeTitle('《差旅 费用-管理办法》')).toBe('差旅费用管理办法');
  });

  it('不做同义词替换（否则「员工手册」会匹配「考勤制度」）', () => {
    expect(normalizeTitle('员工手册')).not.toBe(normalizeTitle('考勤制度'));
  });
});

describe('alignTitle', () => {
  const lib = [
    { title: 'C-星海科技员工手册-完整版(B1专用).md', docTitle: '星海科技员工手册（2026 完整版 · W5 专用）' },
    { title: 'E-星海科技员工手册(2024版).md', docTitle: '星海科技员工手册（2024 版）' },
    { title: 'G-星海科技差旅与费用管理办法.md', docTitle: '星海科技差旅与费用管理办法' },
  ];

  it('引用名比正式标题短时能匹配（子串包含）', () => {
    const r = alignTitle('员工手册（2024版）', lib);
    expect(r).toEqual({ ok: true, title: 'E-星海科技员工手册(2024版).md' });
  });

  it('引用名带书名号也能匹配', () => {
    const r = alignTitle('《差旅与费用管理办法》', lib);
    expect(r).toEqual({ ok: true, title: 'G-星海科技差旅与费用管理办法.md' });
  });

  it('⚠️ 2024 不是 2026 的子串 —— 不能因为字符碰巧重合就匹配', () => {
    // 若用模糊相似度，'员工手册2024版' 对 C 的标题能算出约 78%（C 里有 2、0）
    const r = alignTitle('员工手册（2024版）', lib);
    expect(r.ok && r.title.includes('2024')).toBe(true);
  });

  it('匹配到多个 → ambiguous，不猜', () => {
    const r = alignTitle('星海科技员工手册', lib);
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous' });
  });

  it('泛词太短 → too-short（否则「手册」会匹配整库）', () => {
    const r = alignTitle('手册', lib);
    expect(r).toMatchObject({ ok: false, reason: 'too-short' });
  });

  it('库里没有 → not-found', () => {
    const r = alignTitle('员工手册（2021版）', lib);
    expect(r).toMatchObject({ ok: false, reason: 'not-found' });
  });
});

describe('resolveMetas', () => {
  const rows: DocMetaRow[] = [
    {
      title: 'C-星海科技员工手册-完整版(B1专用).md',
      docTitle: '星海科技员工手册（2026 完整版 · W5 专用）',
      effectiveFrom: '2026-01-01',
      supersedesRaw: ['员工手册（2024版）'],
    },
    {
      title: 'E-星海科技员工手册(2024版).md',
      docTitle: '星海科技员工手册（2024 版）',
      effectiveFrom: '2024-01-01',
      supersedesRaw: ['员工手册（2021版）'],
    },
    {
      title: 'F-无日期制度.md',
      docTitle: '某无日期制度',
      effectiveFrom: null,
      supersedesRaw: [],
    },
  ];

  it('被废止的那篇标 superseded，并指出取代者', () => {
    const { metas } = resolveMetas(rows);
    const e = metas.find((m) => m.title.startsWith('E-'))!;
    expect(e.status).toBe('superseded');
    expect(e.supersededBy).toContain('C-');
  });

  it('没被废止且有日期的标 active', () => {
    const { metas } = resolveMetas(rows);
    const c = metas.find((m) => m.title.startsWith('C-'))!;
    expect(c.status).toBe('active');
    expect(c.supersedes).toEqual(['E-星海科技员工手册(2024版).md']);
  });

  it('⚠️ 既无日期又无人废止 → unknown，不能归成 active', () => {
    // 把"我不知道"说成"这是现行版"，模型会照着说出去
    const { metas } = resolveMetas(rows);
    const f = metas.find((m) => m.title.startsWith('F-'))!;
    expect(f.status).toBe('unknown');
  });

  it('引用库外文件 → 记进 alignFailures 且 reason 是 not-found', () => {
    const { alignFailures } = resolveMetas(rows);
    expect(alignFailures).toHaveLength(1);
    expect(alignFailures[0]).toMatchObject({ ref: '员工手册（2021版）', reason: 'not-found' });
  });

  it('自引用不会把自己标成已废止', () => {
    const self: DocMetaRow[] = [
      {
        title: 'X-某办法.md',
        docTitle: '某办法',
        effectiveFrom: '2026-01-01',
        supersedesRaw: ['某办法'],
      },
    ];
    const { metas } = resolveMetas(self);
    expect(metas[0].status).toBe('active');
  });
});

describe('fenceMetaLabel', () => {
  it('现行版只说日期（默认不打扰）', () => {
    const s = fenceMetaLabel({
      effectiveFrom: '2026-03-01',
      status: 'active',
      supersededBy: null,
    });
    expect(s).toBe(' · 2026-03-01 生效');
  });

  it('已废止版补一句，并指出取代者', () => {
    const s = fenceMetaLabel({
      effectiveFrom: '2024-01-01',
      status: 'superseded',
      supersededBy: 'C-星海科技员工手册-完整版(B1专用).md',
      supersededByDocTitle: '星海科技员工手册（2026 完整版 · W5 专用）',
    });
    expect(s).toContain('2024-01-01 生效');
    expect(s).toContain('已废止');
    expect(s).toContain('2026 完整版');
    expect(s).not.toContain('.md'); // 展示时不带扩展名
    expect(s).not.toContain('C-'); // 也不带文件名前缀
  });

  it('unknown 且无日期 → 空串（调用方据此什么都不加）', () => {
    expect(fenceMetaLabel({ effectiveFrom: null, status: 'unknown', supersededBy: null })).toBe('');
  });
});

describe('statusOf · 单条推导（检索路径用）', () => {
  it('有取代者 → superseded，即使它自己也有效日期', () => {
    expect(statusOf('2024-01-01', 'C-新手册.md')).toBe('superseded');
  });

  it('没取代者但有日期 → active', () => {
    expect(statusOf('2026-01-01', null)).toBe('active');
  });

  it('⚠️ 两者都空 → unknown，不能默认成 active', () => {
    // 老文档（W17 之前上传的）抽不到任何元数据，说它是"现行版"就是编造
    expect(statusOf(null, null)).toBe('unknown');
  });

  it('日期为空的未知态，不能被当成"没有日期所以不显示"而推成 active', () => {
    // 这条是上一条的反面：容易写成 supersededBy ? 'superseded' : 'active'
    expect(statusOf(null, null)).not.toBe('active');
  });
});
