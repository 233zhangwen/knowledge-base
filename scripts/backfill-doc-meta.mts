/**
 * 回填文档元数据（W17）。
 *
 * 用法：
 *   node --experimental-transform-types --import ./scripts/lib/register.mjs scripts/backfill-doc-meta.mts --dry
 *   …… scripts/backfill-doc-meta.mts                   全库回填
 *   …… scripts/backfill-doc-meta.mts --kb=知识库C        只回填指定的库
 *
 * 幂等：重复跑的结果完全一样（先算后写，不依赖上一次的值）。
 * 上传新文档时不需要手动跑 —— 入库链路会自己抽一次（见 index-document.ts）；
 * 这个脚本是给「字段是后加的、已有数据要补」这个场景用的。
 *
 * ## 为什么按库分组算，而不是全局算
 *
 * 废止关系是**库内**关系。库 A 的《员工手册（2024 版）》不会因为库 B 有一份
 * 2026 版就作废 —— 用户检索时只会看到一个库。全局算的话，生产冒烟库里那份
 * C 副本会把知识库C 的 E 标成已废止，而它们在检索上八竿子打不着。
 */
import { loadProjectEnv } from './lib/env.mjs';

loadProjectEnv();

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const kbArg = argv.find((a) => a.startsWith('--kb='));
const KB_NAME = kbArg ? kbArg.slice('--kb='.length) : null;

const { prisma } = await import('../src/lib/prisma.ts');
const { extractDocMeta, resolveMetas } = await import('../src/lib/doc-meta.ts');
const { reportError } = await import('../src/lib/error-report.ts');

type Row = { id: string; title: string; kbId: string; content: string | null };

const docs: Row[] = await prisma.document.findMany({
  where: { content: { not: null }, ...(KB_NAME ? { kb: { name: KB_NAME } } : {}) },
  select: { id: true, title: true, kbId: true, content: true },
  orderBy: { title: 'asc' },
});

if (!docs.length) {
  console.log('没有可回填的文档（content 为空或库名不匹配）');
  await prisma.$disconnect();
  process.exit(0);
}

// 按库分组
const byKb = new Map<string, Row[]>();
for (const d of docs) {
  const list = byKb.get(d.kbId) ?? [];
  list.push(d);
  byKb.set(d.kbId, list);
}

const kbNames = new Map(
  (await prisma.knowledgeBase.findMany({ select: { id: true, name: true } })).map((k) => [k.id, k.name]),
);

let updated = 0;
let warned = 0;

for (const [kbId, rows] of byKb) {
  console.log(`\n===== ${kbNames.get(kbId) ?? kbId}（${rows.length} 篇）=====\n`);

  const extracted = rows.map((r) => ({ row: r, meta: extractDocMeta(r.content ?? '') }));

  const { metas, alignFailures } = resolveMetas(
    extracted.map((e) => ({
      title: e.row.title,
      docTitle: e.meta.docTitle,
      effectiveFrom: e.meta.effectiveFrom,
      supersedesRaw: e.meta.supersedesRaw,
    })),
  );

  for (let i = 0; i < extracted.length; i += 1) {
    const { row, meta } = extracted[i];
    const resolved = metas[i];

    const flag =
      resolved.status === 'superseded' ? '✗ 废止' : resolved.status === 'active' ? '✓ 现行' : '? 未知';
    console.log(`${flag}  ${(resolved.effectiveFrom ?? '----------')}  ${row.title}`);
    console.log(`       H1: ${resolved.docTitle ?? '(无)'}`);
    if (resolved.supersededBy) console.log(`       ← 被「${resolved.supersededBy}」取代`);
    if (resolved.supersedes.length) console.log(`       → 废止了：${resolved.supersedes.join('、')}`);
    for (const w of meta.warnings) console.log(`       ⚠  ${w}`);

    if (DRY) continue;
    await prisma.document.update({
      where: { id: row.id },
      data: {
        effectiveFrom: resolved.effectiveFrom,
        docTitle: resolved.docTitle,
        supersededBy: resolved.supersededBy,
      },
    });
    updated += 1;
  }

  // ---- 对齐失败留痕 ----
  for (const f of alignFailures) {
    /**
     * 只把「需要人看」的失败落库。
     *
     * not-found 绝大多数是正常情况：文档引用了库外的文件
     * （E 引用《员工手册（2021 版）》、G 引用《差旅费用报销细则（2024）》），
     * 这些文件本来就没上传，标不出来是对的。每条都报会把真正的异常淹掉。
     *
     * 而 ambiguous 是「库里有、但我不敢选」——那是**我的算法不够好**，
     * 必须让人知道；too-short 是引用名太泛（比如只写了「手册」），
     * 说明文档写法有问题，也值得看一眼。
     */
    const notable = f.reason === 'ambiguous' || f.reason === 'too-short';
    if (!notable) {
      console.log(`       · 跳过库外引用「${f.ref}」（正常）`);
      continue;
    }
    console.log(`       ⚠  对齐失败「${f.ref}」[${f.reason}]`);
    warned += 1;
    if (DRY) continue;
    await reportError({
      level: 'warn',
      event: 'docmeta.align_failed',
      message: `${f.from} 的废止声明「${f.ref}」无法对齐到库内文档（${f.reason}）`,
      path: 'scripts/backfill-doc-meta',
    });
  }
}

console.log(
  `\n${DRY ? '[dry] 未写入。' : `已更新 ${updated} 篇。`}需人工处理的失败 ${warned} 条。`,
);

await prisma.$disconnect();
