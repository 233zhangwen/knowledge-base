/**
 * 检索：把用户的问题变成问句向量，在这个**知识库内部**找出最相关的若干片段。
 *
 * 三个关键约束，每条都是为了 spec 里的某条验收标准存在的：
 *
 * ① `where d."kbId" = ${kbId}` —— 对应 A1 / D1。
 *    没有这一句，用户会在这个知识库里问出隔壁知识库、甚至别人账号的内容，
 *    而界面上看起来完全正常（引用照样挂着一串相关段落）。这是**静默事故**，
 *    比报错危险得多。kbId 由调用方传入，但调用方必须已经做过归属校验。
 *
 * ② `and d.status = 'ready'` —— 对应 C3。
 *    W3 的失败流程可能给 failed 文档留下旧 chunks（重索引前的残留），
 *    不去过滤的话，"解析失败的文档照样能被搜出来"这种事就会发生。
 *
 * ③ 排序必须用 `<=>`（余弦距离，**越小越相似**）—— 对应 A2。
 *    它和 `<->`（欧氏距离）长得像但语义不同，写反了照样有结果、照样不报错，
 *    只是检索质量悄悄变差。similarity 用 `1 - distance` 转回"越大越像"。
 *
 * 注：`limit ${TOP_K}` 里的 ${} 是 Prisma 的**参数化占位符**（会变成 $N），
 * 不是字符串拼接 —— 和 $3::vector 一样，没有注入风险。
 */
import { embedTexts } from './embedding';
import { prisma } from './prisma';

/**
 * 召回条数。理由（写进 ACCEPTANCE-W4.md 决策①）：
 * 5 块 × 约 500 字 ≈ 2500 字，远在模型上下文窗口内，所以限制我们的不是窗口大小，
 * 而是**注意力稀释** —— 塞 20 条进去，真正有用的那条反而被淹没。
 */
export const TOP_K = 5;

export type RetrievedChunk = {
  id: string;
  content: string;
  chunkIndex: number;
  documentId: string;
  documentTitle: string;
  /** 余弦相似度，0~1，越大越相似。仅用于日志观测，不用于裁断是否回答。 */
  similarity: number;
};

type Row = {
  id: string;
  content: string;
  chunkIndex: number;
  documentId: string;
  title: string;
  similarity: number;
};

export async function retrieve(kbId: string, question: string): Promise<RetrievedChunk[]> {
  const t0 = Date.now();

  const [vector] = await embedTexts([question]);
  const vectorLiteral = `[${vector.join(',')}]`;

  const rows = await prisma.$queryRaw<Row[]>`
    select c.id,
           c.content,
           c."chunkIndex",
           d.id as "documentId",
           d.title,
           1 - (c.embedding <=> ${vectorLiteral}::vector) as similarity
    from "Chunk" c
    join "Document" d on d.id = c."documentId"
    where d."kbId" = ${kbId} and d.status = 'ready'
    order by c.embedding <=> ${vectorLiteral}::vector
    limit ${TOP_K}
  `;

  const chunks = rows.map((r) => ({
    id: r.id,
    content: r.content,
    chunkIndex: r.chunkIndex,
    documentId: r.documentId,
    documentTitle: r.title,
    // pg 的 numeric/double precision 经 Node 驱动回来是字符串，必须显式转 Number
    similarity: Number(r.similarity),
  }));

  /**
   * E2 要求的观测日志：每次检索一行。
   * 现在顺手打出来，W6 调优才有数据；到时候再回头加埋点，要重读一遍 W4 的代码。
   */
  console.log(
    `[retrieve] kb=${kbId.slice(0, 8)} 召回 ${chunks.length} 条 ` +
      `top1=${chunks[0]?.similarity.toFixed(4) ?? 'N/A'} 耗时 ${Date.now() - t0}ms`,
  );

  return chunks;
}
