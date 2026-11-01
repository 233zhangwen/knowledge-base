/**
 * 标注自检：expectChunks 指的块里，到底有没有答案。
 *
 * 起因是 W17 发现 v03 的标注指错了块（问"辞职提前多久"，标的是讲《离职交接单》的那块，
 * 真正的"30 天"在上一块）。`--check` 查不出来 —— 它只校验 snippet 与块首匹配，
 * 而"块首匹配"和"这块回答得了这个问题"是两件事。
 *
 * ⚠️ 这个脚本给的是**可疑清单，不是错误清单**。
 * 有些答案需要跨块推导（c19 年假+婚假求和），单个块里本来就没有那个数字。
 * 所以它只回答一个很窄的问题：这条 case 的首选证据块，连一个答案关键词都不含，正常吗？
 */
import { loadProjectEnv } from './lib/env.mjs';

loadProjectEnv();

const fs = await import('node:fs');
const { prisma } = await import('../src/lib/prisma.ts');

type Case = {
  id: string;
  question: string;
  documentTitle: string;
  expectChunks: { index: number; snippet: string }[];
  answerMustContain?: string[] | null;
  answerAnyOf?: string[][] | null;
};

const cases: Case[] = JSON.parse(fs.readFileSync('eval/cases.json', 'utf8'));
const KB = '知识库C';

const kb = await prisma.knowledgeBase.findFirst({ where: { name: KB }, select: { id: true } });
const docs = await prisma.document.findMany({
  where: { kbId: kb!.id },
  select: { id: true, title: true },
});
const idByTitle = new Map(docs.map((d) => [d.title, d.id]));

const chunks = await prisma.$queryRaw<{ documentId: string; chunkIndex: number; content: string }[]>`
  select c."documentId", c."chunkIndex", c.content
    from "Chunk" c join "Document" d on d.id = c."documentId"
   where d."kbId" = ${kb!.id}`;

const contentOf = new Map(chunks.map((c) => [`${c.documentId}#${c.chunkIndex}`, c.content]));

let suspicious = 0;
let missing = 0;

for (const c of cases) {
  const docId = idByTitle.get(c.documentTitle);
  if (!docId) {
    console.log(`✗ ${c.id}  文档不在库里：${c.documentTitle}`);
    missing += 1;
    continue;
  }

  const musts = [...(c.answerMustContain ?? []), ...(c.answerAnyOf ?? []).map((g) => g[0])];
  if (!musts.length) continue; // 没有判据的题跳过（多跳题降级后保留的那些）

  const texts = c.expectChunks.map((e) => contentOf.get(`${docId}#${e.index}`) ?? '');
  const anyHit = texts.some((t) => musts.some((m) => t.replace(/\s+/g, '').includes(m.replace(/\s+/g, ''))));

  if (!anyHit) {
    suspicious += 1;
    console.log(`⚠ ${c.id.padEnd(5)} 证据块里没有答案关键词 ${JSON.stringify(musts)}`);
    console.log(`       问：${c.question}`);
    console.log(`       标：${c.documentTitle} ${c.expectChunks.map((e) => `#${e.index}`).join(',')}`);
    for (const [i, t] of texts.entries()) {
      console.log(`       #${c.expectChunks[i].index}: ${t.replace(/\s+/g, ' ').slice(0, 60)}`);
    }
  }
}

console.log(`\n共 ${cases.length} 条，可疑 ${suspicious} 条，文档缺失 ${missing} 条`);
await prisma.$disconnect();
