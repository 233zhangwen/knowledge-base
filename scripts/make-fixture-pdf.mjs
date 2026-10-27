/**
 * 生成冒烟测试用 PDF（零依赖，手写 PDF 结构）。
 *
 * 为什么手写而不是装库：只需要一份几页、文本可提取的样本，
 * 为一个一次性 fixture 往依赖里塞 pdfkit/jspdf 不划算；而 PDF 的
 * 最小可用子集（Catalog / Pages / Page / Font / Contents + xref）足够短。
 *
 * 内容用英文：PDF 里嵌中文字体需要 CID 字体子集，成本高；
 * 而 bge-m3 是跨语言模型，中文提问照样能召回英文段落 —— 冒烟目的是
 * 验证"PDF 解析链路在 serverless 上能跑通"，不是验证中文排版。
 *
 * 用法：node scripts/make-fixture-pdf.mjs [输出路径]
 */
import { writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'kb-fixtures/D-Data-Retention-Policy(PDF-smoke).pdf';

/** 每页内容（纯 ASCII，避免编码问题）。事实点写成可判分的具体数字。 */
const pages = [
  [
    'Star Sea Technology - Data Retention Policy',
    'Version 3.1 / Effective 2026-01-01 / Owner: Data Governance Office',
    '',
    '1. Scope',
    'This policy applies to all production systems, internal tools and',
    'third-party services that process company or customer data.',
    '',
    '2. Application logs',
    'Application logs are retained for 180 days. After that window they are',
    'deleted automatically by the log rotation job, which runs every night',
    'at 02:00 Singapore time.',
    '',
    '3. Audit logs',
    'Security audit logs are retained for 365 days because the annual',
    'compliance review needs a full twelve-month window. Audit logs are',
    'write-once: no employee, including administrators, can modify or',
    'delete an audit record before its retention period expires.',
    '',
    '4. Backups',
    'A full backup runs daily at 03:00 and is kept for 35 days. Incremental',
    'backups run every four hours and are kept for 7 days. Backups are',
    'encrypted with AES-256 and stored in the Singapore region.',
    '',
    '5. Primary data center',
    'The primary data center is located in Singapore. A cold standby site',
    'in Frankfurt is activated only during a declared disaster.',
  ],
  [
    '6. Customer data deletion',
    'When a customer account is closed, all personal data must be deleted',
    'within 30 days. A deletion certificate is issued to the customer after',
    'the deletion job completes.',
    '',
    '7. Employee data',
    'Records of former employees are archived for 2 years after the last',
    'working day, then destroyed. Payroll records are kept for 10 years as',
    'required by tax law.',
    '',
    '8. Incident reports',
    'Incident reports are retained for 5 years. Reports involving a data',
    'breach are retained for 7 years and are reviewed by the legal team',
    'every six months.',
    '',
    '9. Exceptions',
    'Any exception to this policy requires written approval from the Chief',
    'Information Security Officer and must be re-approved every 12 months.',
    '',
    '10. Contact',
    'Questions about this policy: dpo@starsea.example',
  ],
];

/** 把一页的文本行转成 PDF 内容流（每行一个 Tj，行距 16pt）。 */
function contentStream(lines) {
  const escaped = lines.map((l) => l.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'));
  const ops = ['BT', '/F1 11 Tf', '16 TL', '56 760 Td'];
  for (const line of escaped) {
    ops.push(`(${line}) Tj`, 'T*');
  }
  ops.push('ET');
  return ops.join('\n');
}

// ── 组装 PDF 对象 ──────────────────────────────────────────────
const objects = []; // 1-based，objects[i-1] 是对象 i 的内容
const pageObjIds = [];

// 1: Catalog, 2: Pages, 3: Font
objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
objects[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

// 每页占两个对象：Page、Contents
let nextId = 4;
for (const lines of pages) {
  const pageId = nextId++;
  const contentId = nextId++;
  pageObjIds.push(pageId);
  const stream = contentStream(lines);
  objects[pageId - 1] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
    `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
  objects[contentId - 1] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
}
objects[1] =
  `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] ` +
  `/Count ${pageObjIds.length} >>`;

// ── 序列化 + 计算 xref 偏移 ────────────────────────────────────
let pdf = '%PDF-1.4\n';
const offsets = [];
for (let i = 0; i < objects.length; i++) {
  offsets[i] = Buffer.byteLength(pdf, 'latin1');
  pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
}
const xrefStart = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) {
  pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

writeFileSync(out, Buffer.from(pdf, 'latin1'));
console.log(`已生成 ${out}（${pages.length} 页，${Buffer.byteLength(pdf, 'latin1')} 字节）`);
