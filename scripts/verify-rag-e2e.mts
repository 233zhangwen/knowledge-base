/**
 * W4 端到端冒烟：**不走浏览器**跑一遍真实的「检索 → 拼 Prompt → 流式生成 → 前端解析」。
 *
 * 为什么要写它：spec 里最难判的两条是 A3（无依据时要说"文档里没有"）和
 * B4（不许用常识纠正文档）。这两条问的是**模型行为**，不是代码行为，
 * 光看代码永远不知道答案 —— 必须真的问一次。而且将来 W6 调 Prompt / 换模型，
 * 这个脚本就是回归基线。
 *
 * 跑法：
 *   node --experimental-transform-types --import ./scripts/lib/register.mjs scripts/verify-rag-e2e.mts "你的问题" [kbId]
 *   （或 npm run verify:rag -- "你的问题"）
 *
 * W17 起**不再复刻检索 SQL**。原来这里抄了一份 retrieve.ts 的查询，注释写着
 * "改了那边必须同步改这里" —— 而这种靠注释维持的一致性从来没成立过：
 * 那份副本没有 rerank（W15）、没有 suspicious（W14）、也没有元数据（W17），
 * 于是这个"端到端冒烟"验证的是一条线上不存在的链路。
 * 现在直接 import 真的 retrieve，和 eval-agent.mts 的做法一致。
 */
import { loadProjectEnv } from './lib/env.mjs';
import {
  createCursor,
  encodeHeadLine,
  feed,
  type Citation,
} from '../src/lib/chat-protocol.ts';
import { buildRagMessages, streamChat } from '../src/lib/llm.ts';

// 必须在 import prisma 之前
loadProjectEnv();

const { retrieve } = await import('../src/lib/retrieve.ts');
const { prisma } = await import('../src/lib/prisma.ts');

const question = process.argv[2];
if (!question) {
  console.error('用法：npm run verify:rag -- "问题" [kbId]');
  process.exit(1);
}
const kbIdArg = process.argv[3];

async function main() {
  // kbId 没给就挑 chunk 最多的知识库（和 db-query.mjs【6】同一个选择逻辑）
  const kbId =
    kbIdArg ??
    (
      await prisma.$queryRaw<{ kbId: string }[]>`
        select d."kbId"
          from "Chunk" c join "Document" d on d.id = c."documentId"
         where d.status = 'ready'
         group by d."kbId" order by count(*) desc limit 1`
    )[0]?.kbId;

  if (!kbId) {
    console.error('库里没有任何 ready 文档的 chunk，先上传并索引一个文档');
    process.exit(1);
  }

  // ① 检索（真 retrieve：粗排 → rerank → 元数据，与线上逐字节相同）
  const chunks = await retrieve(kbId, question);

  console.log(`知识库 ${kbId}\n问题：${question}\n`);
  console.log(`【检索】召回 ${chunks.length} 条`);
  for (const [i, c] of chunks.entries()) {
    const meta = [c.effectiveFrom ? `${c.effectiveFrom} 生效` : null, c.supersededBy ? '已废止' : null]
      .filter(Boolean)
      .join(' · ');
    console.log(
      `  [${i + 1}] ${c.docTitle || c.documentTitle} 第${c.chunkIndex + 1}段 ` +
        `sim=${c.similarity.toFixed(4)}${meta ? ` · ${meta}` : ''}`,
    );
  }

  const citations: Citation[] = chunks;

  // ② 生成（真 llm.ts）
  const t0 = Date.now();
  let firstTokenAt = 0;
  let text = '';
  let stream = encodeHeadLine({ citations, conversationId: null }); // ③ 顺手用真协议包一遍流
  for await (const delta of streamChat(buildRagMessages(question, chunks))) {
    if (!firstTokenAt) firstTokenAt = Date.now() - t0;
    text += delta;
    stream += delta;
    process.stdout.write(delta);
  }

  console.log(
    `\n\n【生成】首字 ${firstTokenAt}ms / 总耗时 ${Date.now() - t0}ms / ${text.length} 字`,
  );

  // ④ 让真解析器读一遍这整条流，验证"前端视角"拿到的是什么
  const cursor = createCursor();
  feed(cursor, stream);
  console.log(
    `【协议解析】citations=${cursor.citations.length} answer=${cursor.answer.length} 字 ` +
      `一致=${cursor.answer === text && cursor.citations.length === citations.length}`,
  );

  // ⑤ 引用编号检查（spec B2）：模型引用的编号必须落在本次召回范围内
  const used = [...new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))].sort(
    (a, b) => a - b,
  );
  const outOfRange = used.filter((n) => n < 1 || n > citations.length);
  console.log(`【引用检查】答案里出现的编号 ${JSON.stringify(used)}`);
  console.log(
    outOfRange.length === 0
      ? `✅ 全部落在 [1..${citations.length}] 内，没有幻觉引用`
      : `❌ 越界编号 ${JSON.stringify(outOfRange)} —— 模型编造了引用`,
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('\n失败：', e instanceof Error ? e.message : e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
