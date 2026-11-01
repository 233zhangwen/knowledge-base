/**
 * 静态审计：src/ 下每个业务查询是否带租户条件（W19）。
 *
 * 为什么需要静态检查，明明已经有越权测试了：
 *   测试证明的是「带了这个条件就挡得住」；
 *   它证明不了「新写的那条查询带了条件」—— 因为新查询通常也伴随着新测试还没写。
 *   租户条件漏写不会报错、不会变慢、功能看起来正常，唯一能发现它的是**把每条查询都数一遍**。
 *
 * 为什么不引 ts-morph / ESLint 规则：
 *   这个检查只需要回答一个问题 —— "这个调用的参数里有没有 orgId"。
 *   为它装一个 AST 框架、再处理一遍版本兼容，成本高于收益。
 *   括号配对 + 跳过字符串的实现只有几十行，出问题也看得懂。
 *   （代价：识别不了 `const where = {...}; prisma.x.findMany({ where })` 这种间接写法。
 *    本项目没有这种写法，真出现时它会报"未覆盖"，是保守方向，不会漏。）
 *
 * 用法：npm run check:scope
 * 退出码：有未覆盖的调用 → 1
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('src');
const MODELS = ['knowledgeBase', 'conversation', 'document', 'chunk'];

type Allow = { file: string; method: string; why: string };

/**
 * 白名单：这些调用确实不带 orgId，且论证过为什么安全。
 *
 * ⚠️ 加白名单必须写理由，而且理由要回答「攻击者能不能控制这个 id」——
 *    "内部函数""应该没问题"这类理由不算，它们是白名单腐化的开始。
 */
const ALLOW: Allow[] = [
  {
    file: 'src/app/kb/[id]/actions.ts',
    method: 'document.create',
    why: '上传流程：kbId 已在上方 findFirst({ id, orgId }) 校验过，才走到 create',
  },
  {
    file: 'src/app/kb/[id]/actions.ts',
    method: 'document.update',
    why: '按 id 更新状态/正文/storageKey：上传流程用刚 create 的 id，重建索引用已过 kb.orgId 校验查到的 id，两者客户端都碰不到',
  },
  {
    file: 'src/lib/index-document.ts',
    method: 'document.update',
    why: '索引流水线内部，入参 documentId 由调用方（已校验归属的 Action）给出',
  },
  {
    file: 'src/lib/index-document.ts',
    method: 'document.findUnique',
    why: '同上：按 documentId 取正文送切片，调用链起点是已校验的 Action',
  },
  {
    file: 'src/lib/doc-meta-store.ts',
    method: 'document.update',
    why: '元数据回填，按 documentId 写 4 个派生字段（日期/废止关系），不读用户内容',
  },
  {
    file: 'src/lib/doc-meta-store.ts',
    method: 'document.findMany',
    why: '按 kbId 扫全库算废止关系，kbId 来自刚入库的文档；回填脚本另走 admin 路径',
  },
  {
    file: 'src/app/api/kb/[id]/chat-agent/route.ts',
    method: 'conversation.update',
    why: '只更新 updatedAt 让会话排到侧栏顶部，id 来自 resolveConversation（已校验 orgId）',
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'generated') continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** 从 openIdx（指向 '('）开始，返回配对右括号的下标；跳过字符串与注释。 */
function matchParen(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];

    // 行注释
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      if (nl === -1) return -1;
      i = nl;
      continue;
    }
    // 块注释
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    // 字符串（含模板串 —— 模板里的 ${} 不展开，够用了，因为我们的查询没这么写）
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      for (let j = i + 1; j < text.length; j++) {
        if (text[j] === '\\') {
          j++;
          continue;
        }
        if (text[j] === quote) {
          i = j;
          break;
        }
      }
      continue;
    }

    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

type Hit = { file: string; line: number; model: string; method: string; snippet: string };

function scanFile(full: string): Hit[] {
  const text = fs.readFileSync(full, 'utf8');
  const rel = path.relative(process.cwd(), full).replace(/\\/g, '/');
  const hits: Hit[] = [];

  for (const model of MODELS) {
    const re = new RegExp(`prisma\\.${model}\\.(\\w+)\\s*\\(`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const openIdx = text.indexOf('(', m.index + `prisma.${model}.${m[1]}`.length);
      const closeIdx = matchParen(text, openIdx);
      if (closeIdx === -1) continue;

      const args = text.slice(openIdx, closeIdx + 1);
      const line = text.slice(0, m.index).split('\n').length;
      hits.push({
        file: rel,
        line,
        model,
        method: m[1],
        snippet: args,
      });
    }
  }
  return hits;
}

const files = walk(SRC);
const all = files.flatMap(scanFile);

const withScope: Hit[] = [];
const allowed: { hit: Hit; why: string }[] = [];
const uncovered: Hit[] = [];

for (const hit of all) {
  // "带租户条件"的判定：参数里出现 orgId。
  // 认这个字面量就够了 —— 本项目所有租户字段都叫 orgId，改名会同时打到这里。
  if (/\borgId\b/.test(hit.snippet)) {
    withScope.push(hit);
    continue;
  }
  const allow = ALLOW.find((a) => a.file === hit.file && a.method === `${hit.model}.${hit.method}`);
  if (allow) allowed.push({ hit, why: allow.why });
  else uncovered.push(hit);
}

console.log(`扫描 ${files.length} 个文件，命中 ${all.length} 处业务查询\n`);
console.log(`✅ 带租户条件：${withScope.length}`);
for (const h of withScope) console.log(`   ${h.file}:${h.line}  ${h.model}.${h.method}`);

console.log(`\n⚠️  白名单（已论证，共 ${allowed.length}）`);
for (const { hit, why } of allowed) {
  console.log(`   ${hit.file}:${hit.line}  ${hit.model}.${hit.method}`);
  console.log(`      理由：${why}`);
}

if (uncovered.length) {
  console.log(`\n❌ 未覆盖（共 ${uncovered.length}）—— 这些查询没有 orgId，也不在白名单里`);
  for (const h of uncovered) {
    console.log(`   ${h.file}:${h.line}  ${h.model}.${h.method}`);
    console.log(`      ${h.snippet.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  console.log('\n处理方式二选一：加租户条件，或在 ALLOW 里写清"攻击者能不能控制这个 id"。');
  process.exit(1);
}

console.log('\n✅ 所有业务查询都有租户条件或已在白名单中论证过。');
console.log('\nℹ️  本检查不覆盖 $queryRaw —— 向量检索必须走原生 SQL（Prisma 不支持 vector 表达式）。');
console.log('   那一层的租户边界在调用方：retrieve(kbId, …) 的 kbId 由路由校验过 orgId 后才传入。');
