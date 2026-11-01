/**
 * 答案判据（W16 抽出，`eval-agent.mts` 与 `eval.mjs` 共用）。
 *
 * ## 为什么不能只用 `answer.includes(kw)`
 *
 * W16 跑第一版基线时，45 条里挂了 2 条，逐条看下来**根因全是判据，不是模型**：
 *
 *   c12  判据要「禁止」，答案写「不可以……不能自行安装」    → 同义表达，语义完全正确
 *   s05  判据要「8 周」，答案写「8周」                      → 差一个空格
 *
 * 这类误判最危险的地方在于它**方向固定**：它只会把对的判成错的，
 * 于是你看到"成绩不好"，去改 prompt、改检索、加 rerank —— 治的全是假病。
 * 反过来，如果判据过宽（把错的判成对的），问题会被静默掩盖，更糟。
 *
 * ## 所以这里的策略是「归一化 + 显式同义词」，不做智能匹配
 *
 * 1. **归一化只做无损的**：去空白（含全角空格）、全角数字转半角。
 *    这是纯格式差异，不涉及语义，可以自动化。
 * 2. **同义词必须显式声明**（`answerAnyOf`），由人来判断。
 *    因为"禁止 / 不能 / 不得"到底算不算同一个意思，只有出题的人有权决定；
 *    让机器去猜同义关系，就是在给判据引入不可解释的宽松。
 *
 * 宁可严格（误判为错 → 有人会发现并修正），不可宽松（误判为对 → 静默掩盖）。
 */

/**
 * 归一化：去所有空白 + 全角数字转半角。
 * 不做中文数字转换（"十七" ↔ "17"）—— 那一层有歧义（"一百二十三"、"两"、"俩"），
 * 猜错方向的代价比收益大。遇到这类题，出题时把两种写法都写进 answerAnyOf。
 */
export function normalizeAnswer(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/[\s\u3000\u00a0]+/g, '')
    .replace(/[\uff10-\uff19]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
}

/**
 * 判定一条答案。
 *
 * @param {string} answer 模型输出
 * @param {{ answerMustContain?: string[] | null, answerAnyOf?: string[][] | null }} c 用例
 * @returns {{ ok: boolean, missed: string[], failedGroups: string[][] }}
 *
 * 语义：
 *   - `answerMustContain`：每一条都必须出现（AND）
 *   - `answerAnyOf`：每组里至少出现一个（组内 OR，组间 AND）
 */
export function matchAnswer(answer, c) {
  const norm = normalizeAnswer(answer);

  const missed = (c.answerMustContain ?? []).filter((kw) => !norm.includes(normalizeAnswer(kw)));

  const failedGroups = (c.answerAnyOf ?? []).filter(
    (group) => !group.some((kw) => norm.includes(normalizeAnswer(kw))),
  );

  return { ok: missed.length === 0 && failedGroups.length === 0, missed, failedGroups };
}

/** 把判定结果压成一行人话（两个脚本的报告都要用）。 */
export function describeMiss(missed, failedGroups) {
  const parts = [];
  if (missed.length) parts.push(`缺「${missed.join('、')}」`);
  for (const g of failedGroups) parts.push(`缺其一「${g.join('/')}」`);
  return parts.join(' ');
}
