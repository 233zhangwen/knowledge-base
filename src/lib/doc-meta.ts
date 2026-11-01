/**
 * 文档元数据：从正文抽出生效日期与废止关系，再把"引用名"对齐到"库里的文档"（W17）。
 *
 * 为什么需要这一层：块级检索拿回来的是 500 字的片段，而"这是哪一版"是**文档级**事实。
 * C 文档的废止声明在第 3706 字，命中婚假问题的 C#2 在第 700 字附近 —— 模型看到 C#2 时
 * 根本不知道库里还有一份 2024 版、更不知道那份已经作废。它能做的只有"照抄看起来最相关的那段"。
 *
 * ⚠️ 与 untrusted.ts / context-budget.ts 同一条纪律：**纯函数、零 import、不做 IO**。
 *    脚本能直接 import 这一份跑回填，线上跑的也是这一份，不存在两份实现漂移的可能。
 */

// ---------- 日期 ----------

const CN_DATE = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/;
const ISO_DATE = /(\d{4})-(\d{1,2})-(\d{1,2})/;

/**
 * 把「2026 年 3 月 1 日」「2026-03-01」解析成 **`YYYY-MM-DD` 字符串**。
 *
 * 为什么不是 Date：这个值第一次落库时用的 `DateTime`（Prisma 默认映射成
 * `TIMESTAMP(3)`，不带时区），结果写入时按 UTC 字面值存、读回来按本地 +08 解释，
 * 2026-01-01 变成了 2025-12-31 —— **整整差一天**。而"生效日期差一天"在这种场景里
 * 就是错。根因不是时区没处理对，是**类型选错了**：生效日期的语义是"某一天"，
 * 它没有时分秒，也就没有时区。用 Date 表达它，等于主动引入一个不存在的维度。
 *
 * 字符串的三个好处：零时区问题、ISO 8601 的字典序天然等于日期序、
 * 显示时不用再转换（少一次出错的机会）。代价是数据库层面不能用日期函数，
 * 本项目不需要。
 */
function toIsoDate(y: string, m: string, d: string): string | null {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  // 2 月 30 日这种会被 Date 静默滚到下个月，回读校验挡掉
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseDateIn(text: string): string | null {
  const cn = CN_DATE.exec(text);
  if (cn) return toIsoDate(cn[1], cn[2], cn[3]);
  const iso = ISO_DATE.exec(text);
  if (iso) return toIsoDate(iso[1], iso[2], iso[3]);
  return null;
}

// ---------- 抽取 ----------

export type DateSource = 'header' | 'body' | 'none';

export type ExtractedMeta = {
  /** 文档内的 H1 标题。对齐和展示都优先用它，不用文件名。 */
  docTitle: string | null;
  /** `YYYY-MM-DD`，抽不到为 null。 */
  effectiveFrom: string | null;
  effectiveFromSource: DateSource;
  /** 废止声明里提到的文件名（书名号内的原始写法，未对齐）。 */
  supersedesRaw: string[];
  /** 抽取过程中的疑点。不阻断，只留给人看。 */
  warnings: string[];
};

/** 公文头：`> 生效日期：2024 年 1 月 1 日`（允许前后有 Markdown 引用符号与加粗）。 */
const HEADER_EFFECTIVE = /^[ \t>]*\**[ \t]*生效日期[ \t]*\**[ \t]*[：:][ \t]*(.+)$/m;

/**
 * 正文句：`本手册自 2024 年 1 月 1 日起施行`。
 *
 * 为什么不能只靠公文头：库里 6 篇文档有 5 篇带公文体，唯独 **C（现行版）没有** ——
 * 它是 W2 时期造的，只有 `# 星海科技员工手册（2026 完整版）` 和文末那一句。
 * 按"5/6 有文件头"来决定实现，会恰好漏掉最需要标注的那一份。
 */
const BODY_EFFECTIVE = /自\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*起\s*(?:施行|执行|生效|实施)/g;

/**
 * 废止声明的抽取：**按句子为单位**，而不是按书名号逐个套正则。
 *
 * 最初写的是两条正则（后置/前置各一条），单测立刻暴露它抓不全：
 *   原《甲办法》《乙规定》同时废止。  → 只抓到「甲办法」
 * 因为后置正则的捕获组只能吃一个书名号。并列废止是公文里的常见写法
 * （新规定一次替换掉旧规定和旧细则），抓漏一半等于元数据错一半。
 *
 * 现在的判据是「书名号 与 废止词 的距离够近」：
 *   - 书名号在废止词**之前** 16 字内（`《X》同时废止`）
 *   - 或书名号在废止词**之后** 10 字内（`废止《X》`）
 * 这么做的同时顺手解决第二个坑：`依据《XX办法》制定本办法，原《YY办法》同时废止`
 * 里，`XX办法` 也是书名号、也在同一句，但它不是被废止的。靠"前置依据类动词"排除。
 *
 * 还有一个必须挡住的近似形态：F 文档的
 *   「母公司《员工手册》与本制度不一致的，在成都研发中心范围内以本制度为准。」
 * 它有书名号、有"为准"，但整句没有废止词 —— 按句判断天然排除。
 * 这类"适用范围声明"和"废止声明"长得像、意思相反，误判的代价是让模型拒用现行制度。
 */
const ABOLISH_WORD = /(?:同时废止|即行废止|废止|失效|取代|代替)/g;
/** 句读切分：中文句号/分号/换行都算句子边界（引号内的不算，但公文里罕见）。 */
const SENTENCE = /[^。；;\n]+/g;
const BOOK_TITLE = /《([^》]{2,40})》/g;
/** 这些词后面的书名号是"依据"，不是"被废止"。 */
const CITATION_PREFIX = /(?:依据|根据|按照|遵照|参照|符合|违反|执行)[^，,、。]*$/;

function extractSupersedes(content: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const sent of content.matchAll(SENTENCE)) {
    const s = sent[0];

    const abolishAt = [...s.matchAll(ABOLISH_WORD)].map((m) => m.index!);
    if (!abolishAt.length) continue;

    for (const b of s.matchAll(BOOK_TITLE)) {
      const name = b[1].replace(/\s+/g, '').trim();
      if (!name) continue;

      const at = b.index!;
      const end = at + b[0].length;
      const near = abolishAt.some((a) => (a >= end && a - end <= 16) || (a < at && at - a <= 10));
      if (!near) continue;

      if (CITATION_PREFIX.test(s.slice(0, at))) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }

  return out;
}

/** 文档内 H1（不匹配 `##` 及更深层）。 */
const H1 = /^#(?!#)[ \t]+(.+?)[ \t]*$/m;

export function extractDocMeta(content: string): ExtractedMeta {
  const warnings: string[] = [];

  const h1 = H1.exec(content);
  const docTitle = h1 ? h1[1].trim() : null;

  // --- 生效日期：公文头优先，正文兜底 ---
  let headerDate: string | null = null;
  const headerMatch = HEADER_EFFECTIVE.exec(content);
  if (headerMatch) headerDate = parseDateIn(headerMatch[1]);

  const bodyDates: string[] = [];
  for (const m of content.matchAll(BODY_EFFECTIVE)) {
    const d = toIsoDate(m[1], m[2], m[3]);
    if (d) bodyDates.push(d);
  }

  /**
   * 公文头有值但解析失败 → 说明格式超出预期（如中文数字日期「二〇二六年」）。
   * 这种不能静默跳到正文兜底：那会把"我读不懂"伪装成"文件头没写"。
   */
  if (headerMatch && !headerDate) {
    warnings.push(`公文头的生效日期解析失败：${headerMatch[1].trim().slice(0, 30)}`);
  }

  let effectiveFrom: string | null = null;
  let effectiveFromSource: DateSource = 'none';

  if (headerDate) {
    effectiveFrom = headerDate;
    effectiveFromSource = 'header';
  } else if (bodyDates.length) {
    effectiveFrom = bodyDates[0];
    effectiveFromSource = 'body';
  }

  // 两个来源都读到、但日期不同 → 这是真实的公文错误，必须留痕而不是挑一个
  if (headerDate && bodyDates.length) {
    const same = bodyDates.some((d) => d === headerDate);
    if (!same) {
      warnings.push(`公文头（${headerDate}）与正文（${bodyDates[0]}）的生效日期不一致`);
    }
  }
  if (bodyDates.length > 1 && new Set(bodyDates).size > 1) {
    warnings.push(`正文出现 ${bodyDates.length} 个不同的生效日期，取第一个`);
  }

  // --- 废止关系 ---
  const supersedesRaw = extractSupersedes(content);

  return { docTitle, effectiveFrom, effectiveFromSource, supersedesRaw, warnings };
}

// ---------- 规范化与对齐 ----------

/**
 * 把标题规范成可比较的形式。
 *
 * 为什么需要：同一份文件在三处有三个写法 ——
 *   正文引用：`《员工手册（2024 版）》`
 *   文件名  ：`E-星海科技员工手册(2024版).md`
 *   文档 H1 ：`星海科技员工手册（2024 版）`
 * 差别全在**格式**上（全角/半角括号、书名号、单字母前缀、扩展名、空格），
 * 一个字的内容差别都没有。所以规范化只做格式归一，**不做同义词替换** ——
 * 后者会让「员工手册」和「考勤制度」也匹配上，那是灾难。
 */
export function normalizeTitle(s: string): string {
  let t = s;
  // 文件名前缀 `E-` / `C-`：测试脚手架的痕迹，对语义零贡献
  t = t.replace(/^[A-Za-z][-_]\s*/, '');
  // 扩展名
  t = t.replace(/\.(md|markdown|txt|pdf|docx?)$/i, '');
  // 全角 → 半角（只转括号/数字/字母/空格，不碰汉字）
  t = t
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
  // 书名号、各类括号、点号、连接符：只保留"字"
  t = t.replace(/[《》〈〉()（）[\]【】·•、，,。.：:；;—–\-_\s]/g, '');
  return t;
}

export type AlignResult =
  | { ok: true; title: string }
  | { ok: false; reason: 'not-found' | 'ambiguous' | 'too-short'; candidates?: string[] };

/**
 * 引用名 → 库里的文档。
 *
 * 判据是**子串包含**而不是相似度阈值，理由是它能解释：规范化之后，
 * 「员工手册2024版」确实完整出现在「星海科技员工手册2024版」里，
 * 而「员工手册」虽然也出现在「...2026完整版...」里 —— 但它同时出现在两份文档里，
 * 所以走「唯一匹配」这条闸门被挡下。
 *
 * 用模糊阈值（比如 78%）就会出事：`员工手册（2024 版）` 对 C 的标题算下来约 78%，
 * 因为 C 里有 "2026" 恰好覆盖了引用里的 "2" 和 "0"。**这种"靠字符碰巧重合"的分数
 * 不该有决策权。** 子串包含没有这个问题：2024 不是 2026 的子串。
 *
 * 宁可失败也不猜：错标一份现行文档为"已废止"，比不标危险得多 ——
 * 不标只是回到今天的水平，错标会让模型主动说出错误结论。
 */
export function alignTitle(
  ref: string,
  candidates: { title: string; docTitle?: string | null }[],
): AlignResult {
  const needle = normalizeTitle(ref);
  // 「手册」「办法」这种泛词会把整库都匹配上，必须设下限
  if (needle.length < 4) return { ok: false, reason: 'too-short' };

  const hits = candidates.filter((c) => {
    const hay = normalizeTitle(c.docTitle || c.title);
    return hay.includes(needle) || needle.includes(hay);
  });

  const titles = hits.map((h) => h.title);
  if (titles.length === 0) return { ok: false, reason: 'not-found' };
  if (titles.length > 1) return { ok: false, reason: 'ambiguous', candidates: titles };
  return { ok: true, title: titles[0] };
}

// ---------- 状态推导 ----------

export type DocStatus = 'active' | 'superseded' | 'unknown';

/**
 * 单条推导：有取代者 → 已废止；没取代者但有生效日期 → 现行；都没有 → 不知道。
 *
 * 单独抽成函数是**为了让检索路径和回填脚本共用同一份推导**。
 * 如果 retrieve 里自己写一遍 `supersededBy ? 'superseded' : 'active'`，
 * 就漏了 unknown 这一态，"没有元数据的老文档"会被显示成"现行有效"——
 * 那是把"我不知道"说成"这是最新的"，比不显示更糟。
 */
export function statusOf(
  effectiveFrom: string | null,
  supersededBy: string | null,
): DocStatus {
  if (supersededBy) return 'superseded';
  return effectiveFrom ? 'active' : 'unknown';
}

export type DocMetaRow = {
  title: string;
  docTitle: string | null;
  effectiveFrom: string | null;
  supersedesRaw: string[];
};

export type ResolvedMeta = {
  title: string;
  docTitle: string | null;
  effectiveFrom: string | null;
  status: DocStatus;
  /** 只有当 status === 'superseded' 时有值。 */
  supersededBy: string | null;
  /** 本文件废止了哪些（对齐成功的）。 */
  supersedes: string[];
  warnings: string[];
};

/**
 * 一批文档的元数据互相解算。
 *
 * 必须是**整批**算而不是逐篇算：废止关系是文档间的边，"谁废止我"要遍历别人。
 * 逐篇处理会得到"每篇都觉得自己是现行版"。
 *
 * status 的三态是刻意的：`unknown` 表示**既没写生效日期、也没被人废止**。
 * 不能把它归到 active —— 那等于把"我不知道"说成"这是现行有效版本"，
 * 而模型会照着这个说出去。宁可什么都不标。
 */
export function resolveMetas(rows: DocMetaRow[]): {
  metas: ResolvedMeta[];
  alignFailures: { from: string; ref: string; reason: string }[];
} {
  const candidates = rows.map((r) => ({ title: r.title, docTitle: r.docTitle }));
  const alignFailures: { from: string; ref: string; reason: string }[] = [];

  // 谁废止了谁：ref → 施加方
  const supersededBy = new Map<string, string>();
  const edges = new Map<string, string[]>(); // 施加方 → 被废止的库内标题

  for (const r of rows) {
    const ok: string[] = [];
    for (const ref of r.supersedesRaw) {
      /**
       * 排除自引用：文档写「本手册…此前发布的《员工手册（2024 版）》同时废止」，
       * 如果自己的标题也被规范化成同一个串（比如同一份文件的两份副本），
       * 不排除就会出现"自己废止自己"，status 变成 superseded。
       */
      const res = alignTitle(ref, candidates);
      if (!res.ok) {
        /**
         * `not-found` 里混着两种情况，必须分开：
         *   - 引用的是库里没有的文件（《员工手册（2021 版）》）→ 正常，忽略
         *   - 库里有但没匹配上 → 我的算法不够好，要修
         * 这里统一记进 alignFailures 且带上 reason，人工看的时候一眼能分。
         */
        alignFailures.push({ from: r.title, ref, reason: res.reason });
        continue;
      }
      if (res.title === r.title) continue; // 自引用
      ok.push(res.title);
      // 同一份文件被多份新文件废止时，取生效日期最新的那一个作为"取代者"
      const prev = supersededBy.get(res.title);
      if (!prev || newerThan(r, rows.find((x) => x.title === prev))) {
        supersededBy.set(res.title, r.title);
      }
    }
    edges.set(r.title, ok);
  }

  const metas: ResolvedMeta[] = rows.map((r) => {
    const by = supersededBy.get(r.title) ?? null;
    return {
      title: r.title,
      docTitle: r.docTitle,
      effectiveFrom: r.effectiveFrom,
      status: statusOf(r.effectiveFrom, by),
      supersededBy: by,
      supersedes: edges.get(r.title) ?? [],
      warnings: [],
    };
  });

  return { metas, alignFailures };
}

function newerThan(a: DocMetaRow, b: DocMetaRow | undefined): boolean {
  if (!b) return true;
  if (!b.effectiveFrom) return true;
  if (!a.effectiveFrom) return false;
  // ISO 8601 的字典序等于时间序，不需要转 Date
  return a.effectiveFrom > b.effectiveFrom;
}

// ---------- 展示 ----------


/**
 * 围栏头里那一段元数据文字（W17 的核心产出）。
 *
 * 形态上的两个决定：
 *
 * ① **并进围栏头，不新增一行。** 围栏头是块的边界标记，模型必然读到；
 *    新增一行 `【元数据】…` 只是多一行噪音，token 反而更贵。
 *
 * ② **现行版只说日期，已废止版才说全文。** 默认不打扰，异常才强调：
 *    6 篇里 5 篇是现行的，给每块都写「未被废止」纯属浪费 token，
 *    还会稀释掉真正重要的那一条。
 */
export function fenceMetaLabel(meta: {
  effectiveFrom: string | null;
  status: DocStatus;
  supersededBy: string | null;
  supersededByDocTitle?: string | null;
}): string {
  const parts: string[] = [];
  if (meta.effectiveFrom) parts.push(`${meta.effectiveFrom} 生效`);

  if (meta.status === 'superseded') {
    const who = meta.supersededByDocTitle || meta.supersededBy;
    parts.push(who ? `已废止，被《${stripExt(who)}》取代` : '已废止');
  }

  if (!parts.length) return '';
  return ` · ${parts.join(' · ')}`;
}

function stripExt(s: string): string {
  return s.replace(/^[A-Za-z][-_]\s*/, '').replace(/\.(md|markdown|txt|pdf|docx?)$/i, '');
}
