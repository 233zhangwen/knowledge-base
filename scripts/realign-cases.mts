/**
 * 重锚：文档重切片之后，把 cases.json 里的块索引重新指到正确的块上。
 *
 * 为什么需要它（W18）：
 *   `expectChunks` 存的是**块索引**，而块索引是切片算法的派生物。文档改一个字，
 *   贪心合并的分组就重新洗牌，31 条用例的索引全部漂移。W17 当时把这件事记成
 *   「改文档就得让基线作废」，其实那是**锚挂错了地方** —— 挂在派生量上，
 *   而不是不变量上。
 *
 * 不变量是什么：**正文文字**。旧用例的 `snippet` 就是旧块的开头，是一段真实存在过的正文。
 * 只要这段文字还在新文档里，就能找到它落在哪个新块里 —— 这才是重锚，不是"索引加几减几"。
 *
 * 为什么一定能找到：
 *   切片有 80 字重叠，chunk[j] = raw[j-1] 的末尾 80 字 + raw[j] 全部。
 *   所以任何长度 ≤80 的连续正文片段，必然**完整落在某一个块里**（跨边界的那段也在 chunk[j] 里）。
 *   找不到 = 这段文字真的被删了（比如被清理掉的前言），那是**要人看**的信号，不是脚本能猜的。
 *
 * 为什么不能"包含即可"就完事：
 *   命中只能证明"这段文字在这个块里"，不能证明"这块回答得了这个问题"。
 *   旧块的答案可能在块尾，重切片后落到了下一块 —— 所以每条都要再算一次
 *   「答案关键词在不在这个块里」，不在就显式报警并给出 ±1 的建议。
 *   这是 `--check`（结构）和 `check:cases`（语义）之间的那道缝，脚本先补一半。
 *
 * 用法：
 *   npm run realign:cases                      # 只打印映射表，不写文件
 *   npm run realign:cases -- --write           # 写回 eval/cases.json
 *   ... -- --rename="旧标题=新标题"             # 文档改名时把 documentTitle 一起改掉（可重复）
 *   ... -- --accept=m04:evidence:7             # 人工定下来的锚点（可重复），脚本不再替你猜
 *   ... -- --accept=m07:evidence:1>2           # 同一条 case 上多个同名锚点时，写明旧索引
 *   ... -- --keep-evidence="F-xxx.md"          # 该文档正文没动，evidence 索引沿用（可重复）
 *   ... -- --kb=知识库C
 */

import fs from 'node:fs';
import { loadProjectEnv } from './lib/env.mjs';

loadProjectEnv();

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const kbArg = argv.find((a) => a.startsWith('--kb='));
const KB_NAME = kbArg ? kbArg.slice('--kb='.length) : '知识库C';
const RENAMES = argv
  .filter((a) => a.startsWith('--rename='))
  .map((a) => a.slice('--rename='.length).split('='))
  .map(([from, to]) => ({ from, to }));

/**
 * --accept=<id>:<where>:<index>
 *
 * 手动定下来的锚点。存在的理由：有些题（求和的 c19、关键词满库飞的 c20、
 * 没有 snippet 的 evidence）本来就无法只靠字符串定位 —— 那不是脚本不够聪明，
 * 是"这块回答得了这个问题"本身需要人读一遍。
 * 与其让脚本在模糊区间里自己挑一个（错得还很自信），不如要求显式写下来。
 */
const ACCEPTS = argv
  .filter((a) => a.startsWith('--accept='))
  .map((a) => a.slice('--accept='.length))
  .map((s) => {
    // 三种写法：
    //   <id>:<where>:<新索引>
    //   <id>:<where>:<旧索引>><新索引>          —— 一条 case 上多个同名锚点（m07 的 evidence 里 I 出现两次）
    //   <id>:<where>@<文档标题片段>:<旧>><新>    —— 连文档也要一起指定
    const [id, rest, spec] = s.split(':');
    const [where, docFilter] = rest.split('@');
    const [from, to] = spec.includes('>') ? spec.split('>') : [null, spec];
    return {
      id,
      where,
      docFilter: docFilter ?? null,
      from: from === null ? null : Number(from),
      index: Number(to),
    };
  });

/**
 * --keep-evidence=<文档标题>（可重复）：这些文档正文没动，evidence 的索引沿用原值。
 *
 * 为什么不能自动推断：evidence 不带 snippet，脚本没有指纹可以比。
 * 但"没动过"这件事是**可验证的**，前提是操作者先看一眼报告 ——
 * 该文档名下所有带指纹的锚点（expect / confuser）都显示「未变」，
 * 就说明它的切片边界没动，evidence 自然也不用动。
 * 所以这仍然是一个人做的判断，只是把依据写在命令里，而不是藏在脑子里。
 */
const KEEP_EVIDENCE = new Set(
  argv.filter((a) => a.startsWith('--keep-evidence=')).map((a) => a.slice('--keep-evidence='.length)),
);

const { prisma } = await import('../src/lib/prisma.ts');

type Anchor = { documentTitle: string; index: number; snippet?: string };
type Case = {
  id: string;
  documentTitle: string;
  expectChunks: Anchor[];
  confuserChunks?: Anchor[];
  evidence?: { documentTitle: string; index: number }[];
  answerMustContain?: string[] | null;
  answerAnyOf?: string[][] | null;
};

const cases: Case[] = JSON.parse(fs.readFileSync('eval/cases.json', 'utf8'));

// ---------- 锁库 ----------
const kb = await prisma.knowledgeBase.findFirst({ where: { name: KB_NAME }, select: { id: true } });
if (!kb) {
  console.error(`知识库「${KB_NAME}」不存在`);
  process.exit(1);
}

const docs = await prisma.document.findMany({
  where: { kbId: kb.id },
  select: { id: true, title: true },
});
const docByTitle = new Map(docs.map((d) => [d.title, d.id]));

/** 只取本次重锚真正用到的文档，避免 6 篇全量拉进内存。 */
const needed = new Set<string>();
for (const c of cases) {
  needed.add(c.documentTitle);
  for (const e of c.evidence ?? []) needed.add(e.documentTitle);
  for (const e of c.confuserChunks ?? []) needed.add(e.documentTitle);
}
for (const r of RENAMES) {
  needed.delete(r.from);
  needed.add(r.to);
}

const chunksByTitle = new Map<string, string[]>();
for (const title of needed) {
  const id = docByTitle.get(title);
  if (!id) {
    console.error(`✗ 知识库里没有《${title}》—— 先确认 seed 与 --rename 参数`);
    process.exit(1);
  }
  const rows = await prisma.$queryRaw<{ chunkIndex: number; content: string }[]>`
    select "chunkIndex", content from "Chunk" where "documentId" = ${id} order by "chunkIndex"`;
  chunksByTitle.set(title, rows.map((r) => r.content));
}

// ---------- 重锚一条 ----------
type Verdict =
  | { kind: 'moved' | 'same'; to: number; how: string }
  | { kind: 'manual'; why: string };

const mustsOf = (c: Case) => [
  ...(c.answerMustContain ?? []),
  ...(c.answerAnyOf ?? []).map((g) => g[0]),
];

/** 去掉空白再比，避免「8 周」/「8周」这种排版差异把命中判死。 */
const squash = (s: string) => s.replace(/\s+/g, '');

function relink(anchor: Anchor, chunks: string[], musts: string[]): Verdict {
  const snippet = squash(anchor.snippet ?? '');
  if (!snippet) return { kind: 'manual', why: '没有 snippet 指纹（evidence 用的就是这种），只能人工指' };

  const hits = chunks
    .map((c, i) => ({ i, at: squash(c).indexOf(snippet) }))
    .filter((x) => x.at !== -1);

  if (hits.length === 0) return { kind: 'manual', why: '这段话在新文档里找不到了（被删过？）' };

  /**
   * 同一段话通常会在**两个**块里出现 —— 这是 80 字重叠的必然结果，不是脏数据。
   *
   *   chunk[j] = raw[j-1] 的末尾 80 字 + raw[j]
   *
   * 所以「块首那句话」既在 chunk[j] 的开头（位置 0），也在 chunk[j-1] 的结尾（位置 len-80）。
   * 取**位置最靠前**的那个：旧用例标的是「这块从这句话开始讲起」，
   * 而这句话后面的 400 字才是答案所在 —— 那 400 字在 chunk[j] 里，不在 chunk[j-1] 里。
   */
  hits.sort((a, b) => a.at - b.at);
  const to = hits[0].i;
  const tied = hits.filter((h) => h.at === hits[0].at);
  if (tied.length > 1) {
    return { kind: 'manual', why: `同一段话在两个块里都在开头（#${tied.map((h) => h.i).join('/')}），要人看` };
  }

  // 结构对上了，再看语义：答案关键词还得在这块里
  const kwHit = musts.filter((m) => squash(chunks[to]).includes(squash(m)));
  const how = musts.length ? (kwHit.length ? '关键词✓' : '关键词✗') : '无判据';

  if (musts.length && !kwHit.length) {
    // 看一眼邻居能不能救，救得了就把建议写出来，别让人自己翻
    const near = [to - 1, to + 1]
      .filter((i) => i >= 0 && i < chunks.length)
      .filter((i) => musts.some((m) => squash(chunks[i]).includes(squash(m))));
    const hint = near.length ? `，答案疑似在 #${near.join('/')}` : '，答案疑在别处';
    return { kind: 'manual', why: `落到 #${to} 但没有答案关键词${hint}` };
  }
  return { kind: to === anchor.index ? 'same' : 'moved', to, how };
}

// ---------- 跑一遍 ----------
const plan: { c: Case; where: string; anchor: Anchor; verdict: Verdict }[] = [];

for (const c of cases) {
  if (RENAMES.length) {
    const hit = RENAMES.find((r) => r.from === c.documentTitle);
    if (hit) c.documentTitle = hit.to;
    for (const e of c.evidence ?? []) {
      const h2 = RENAMES.find((r) => r.from === e.documentTitle);
      if (h2) e.documentTitle = h2.to;
    }
    for (const e of c.confuserChunks ?? []) {
      const h3 = RENAMES.find((r) => r.from === e.documentTitle);
      if (h3) e.documentTitle = h3.to;
    }
  }

  const musts = mustsOf(c);
  /**
   * ⚠️ expectChunks 里**没有** documentTitle —— 它继承自 case 顶层。
   * 这里必须显式补上，否则 `chunksByTitle.get(undefined)` 拿到 undefined，
   * 然后被下面那句 `if (!chunks) continue` 静默跳过：52 条用例一个锚点都不重锚，
   * 脚本却打印「共 32 处锚点」。**静默跳过是这类脚本最贵的 bug**，
   * 所以上面的 continue 改成先断言标题存在。
   */
  const sites: { where: string; anchor: Anchor }[] = [
    ...c.expectChunks.map((a, i) => ({
      where: `expect[${i}]`,
      anchor: { ...a, documentTitle: c.documentTitle },
    })),
    ...(c.confuserChunks ?? []).map((a, i) => ({ where: `confuser[${i}]`, anchor: a })),
  ];

  for (const { where, anchor } of sites) {
    const chunks = chunksByTitle.get(anchor.documentTitle);
    if (!chunks) continue; // 别的库/别的文档，本次不碰
    // 负例块按定义就**不该**含答案（它的作用是长得像但答非所问），
    // 拿答案关键词去校验它，只会把每条负例都判成可疑 —— 那是判据用错了地方
    const kw = where.startsWith('expect') ? musts : [];
    plan.push({ c, where, anchor, verdict: relink(anchor, chunks, kw) });
  }

  // evidence 只有 index 没有 snippet —— 单独标出来，不静默跳过
  for (const e of c.evidence ?? []) {
    if (!chunksByTitle.has(e.documentTitle)) continue;
    if (KEEP_EVIDENCE.has(e.documentTitle)) {
      // 沿用：报告里仍然打出来，只是不拦写回
      plan.push({
        c,
        where: 'evidence',
        anchor: { documentTitle: e.documentTitle, index: e.index },
        verdict: { kind: 'same', to: e.index, how: '沿用（该文档正文未动）' },
      });
      continue;
    }
    plan.push({
      c,
      where: 'evidence',
      anchor: { documentTitle: e.documentTitle, index: e.index },
      verdict: { kind: 'manual', why: 'evidence 无 snippet，需人工确认' },
    });
  }
}

/**
 * 人工指定的锚点在这里落地。
 *
 * 顺序刻意放在「跑完再覆盖」而不是「跑之前先替换」：先让脚本自己判一遍，
 * 人工与脚本不一致时两边都看得见（报告里 how 会写「人工指定」）。
 * 如果先覆盖，脚本就没机会说话，人工错了也没人拦。
 */
for (const a of ACCEPTS) {
  const cands = plan.filter(
    (x) =>
      x.c.id === a.id &&
      x.where === a.where &&
      (a.docFilter === null || x.anchor.documentTitle.includes(a.docFilter)) &&
      (a.from === null || x.anchor.index === a.from),
  );
  if (cands.length !== 1) {
    console.error(
      `✗ --accept=${a.id}:${a.where} 命中 ${cands.length} 处锚点（需要恰好 1 处；同名锚点请写成 旧>新）`,
    );
    process.exit(1);
  }
  const p = cands[0];
  const chunks = chunksByTitle.get(p.anchor.documentTitle);
  if (!chunks) {
    console.error(`✗ --accept 指向的文档不在本次范围：${p.anchor.documentTitle}`);
    process.exit(1);
  }
  if (!Number.isInteger(a.index) || a.index < 0 || a.index >= chunks.length) {
    console.error(`✗ --accept=${a.id}:${a.where}:${a.index} 越界（该文档 ${chunks.length} 块）`);
    process.exit(1);
  }
  p.verdict = { kind: a.index === p.anchor.index ? 'same' : 'moved', to: a.index, how: '人工指定' };
}

// ---------- 报告 ----------
const moved = plan.filter((p) => p.verdict.kind === 'moved');
const same = plan.filter((p) => p.verdict.kind === 'same');
const manual = plan.filter((p) => p.verdict.kind === 'manual');

for (const p of plan) {
  const short = p.anchor.documentTitle.slice(0, 12);
  if (p.verdict.kind === 'manual') {
    console.log(`⚠ ${p.c.id.padEnd(5)} ${p.where.padEnd(11)} ${short} #${p.anchor.index}  ${p.verdict.why}`);
  } else {
    const mark = p.verdict.kind === 'moved' ? '→' : '=';
    console.log(
      `${p.verdict.kind === 'moved' ? '↔' : ' '} ${p.c.id.padEnd(5)} ${p.where.padEnd(11)} ${short} #${p.anchor.index} ${mark} #${p.verdict.to}  ${p.verdict.how}`,
    );
  }
}

console.log(`\n共 ${plan.length} 处锚点：未变 ${same.length}，移动 ${moved.length}，需人工 ${manual.length}`);

if (!WRITE) {
  console.log('\n--dry（默认）：没有写文件。加 --write 才写回 eval/cases.json');
  await prisma.$disconnect();
  process.exit(0);
}

if (manual.length) {
  console.error('\n✗ 还有需人工确认的锚点，拒绝写入 —— 先手工定下来，再重跑');
  await prisma.$disconnect();
  process.exit(1);
}

// ---------- 写回 ----------
/**
 * 为什么要做字符串级替换，而不是 JSON.parse → 改 → stringify：
 *   cases.json 是**手写排版**的（expectChunks 一行内联、confuserChunks 多行、
 *   字段顺序固定）。整体 stringify 会把 52 条全部重排，diff 变成两千行，
 *   评审时根本看不出"到底改了哪几处"。
 *   而重锚这件事的价值恰恰在于**每一处改动都该被看见** —— 看不见就等于没审。
 */
let text = fs.readFileSync('eval/cases.json', 'utf8');
for (const r of RENAMES) text = text.split(r.from).join(r.to);

/**
 * 取一条 case 的原始文本片段（依赖现有排版，切不出来就报错）。
 *
 * 不用「按缩进匹配行首」那种写法：这个文件是**混排**的 ——
 * c/v/n/s 段是 2 空格缩进，m 段（W16 追加）是 4 空格缩进。
 * 按固定缩进去找边界，会在 m01 那里刚好找不到，而报错信息看起来像"文件坏了"。
 * 改用括号配对：从 `"id"` 往回找到最近的 `{`，再数到配平的 `}`，与缩进无关。
 * 括号计数要跳过字符串内部，否则 snippet 里出现 `{` 就会数错。
 */
function blockOf(id: string): string {
  const marker = `"id": "${id}"`;
  const at = text.indexOf(marker);
  if (at === -1) throw new Error(`cases.json 里找不到 ${id}`);

  const start = text.lastIndexOf('{', at);
  if (start === -1) throw new Error(`${id} 的块起点切不出来`);

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`${id} 的块结尾切不出来（括号没配平）`);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * 写进 JSON 之前必须按 JSON 转义一次。
 *
 * 踩过：新指纹直接取块首 24 字，而块首经常**带着换行**（一段结束、下一段开始就在前 24 字里）。
 * 原样塞进去，`eval/cases.json` 立刻变成非法 JSON —— 报错指向的是别的行，
 * 看起来像文件被谁弄坏了。指纹是**要放进 JSON 的字符串**，不是一段可以随便拼的文本。
 */
const jsonEsc = (s: string) => JSON.stringify(s).slice(1, -1);

let patched = 0;
for (const p of plan) {
  if (p.verdict.kind === 'manual') continue;
  const to = p.verdict.to;
  /**
   * 指纹取新块的**第一行**开头。
   * 不取前 24 个字符：块首常常是「上一段结尾 + 换行 + 下一段开头」，
   * 前 24 字里夹一个换行是常态 —— 而指纹要放进 JSON，换行会被当成裸控制字符。
   * 只取第一行既满足 `startsWith` 匹配，又天然没有换行。
   */
  const rawHead = chunksByTitle.get(p.anchor.documentTitle)![to].trimStart();
  const firstLine = rawHead.split('\n')[0].trim();
  // 首行短得不能当指纹（<4 字）时退回原样 24 字，换行交给 jsonEsc 处理
  const head = (firstLine.length >= 4 ? firstLine : rawHead).slice(0, 24);
  const indexChanged = to !== p.anchor.index;
  /**
   * evidence 没有 snippet 字段，所以它**不存在"指纹过期"这回事** ——
   * 索引没变就是真的没事发生。第一版漏了这个分支，
   * 于是每条"沿用"的 evidence 都被当成要改，替换出来和原文一模一样，
   * 反而触发了"没找到对应片段"的错误。把没有的东西当有过，比漏判更难查。
   */
  const snippetStale =
    p.where === 'evidence' ? false : p.anchor.snippet ? !head.startsWith(p.anchor.snippet) : true;
  if (!indexChanged && !snippetStale) continue; // 什么都没变，一个字都不动

  const block = blockOf(p.c.id);

  let next: string;
  let re: RegExp;
  if (p.where === 'evidence') {
    // evidence 没有 snippet 字段，只有 { documentTitle, index }
    re = new RegExp(
      `("documentTitle":\\s*"${esc(p.anchor.documentTitle)}",\\s*"index":\\s*)${p.anchor.index}(\\s*\\})`,
    );
    // 用回调而不是 `$1...$2`：替换串里一旦出现 `$` 就会被当成替换模式
    next = block.replace(re, (_m, a: string, b: string) => `${a}${to}${b}`);
  } else {
    // expectChunks / confuserChunks：index 与 snippet 一起换（排版可能是行内也可能是分行）
    re = new RegExp(
      `("index":\\s*)${p.anchor.index}(\\s*,\\s*"snippet":\\s*")${esc(jsonEsc(p.anchor.snippet ?? ''))}(")`,
    );
    next = block.replace(re, (_m, a: string, b: string, c: string) => `${a}${to}${b}${jsonEsc(head)}${c}`);
  }

  if (next === block) {
    console.error(`✗ ${p.c.id} ${p.where}：在 JSON 文本里没找到对应片段，拒绝半途而废`);
    console.error(`   title=${p.anchor.documentTitle} index=${p.anchor.index} re=${re.source}`);
    console.error(`   block 里有没有这个名字：${block.includes(p.anchor.documentTitle)}`);
    await prisma.$disconnect();
    process.exit(1);
  }
  // 用函数做替换：字符串形态的 replace 会把 snippet 里的 `$&` 之类当成替换模式
  text = text.replace(block, () => next);
  patched += 1;
}

fs.writeFileSync('eval/cases.json', text);
console.log(`\n✓ 已写回 eval/cases.json，改动 ${patched} 处`);
console.log('下一步：node scripts/eval.mjs --check（结构） + npm run check:cases（语义）');
await prisma.$disconnect();
