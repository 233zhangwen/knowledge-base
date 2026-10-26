/**
 * W5 验收用数据构造脚本。
 *
 * 为什么需要它：spec 里有两条靠手点造不出来数据 ——
 *   A6  要在一个知识库下有 25 个会话（验证侧栏上限 20）
 *   C1  要一条**属于别人**的会话当诱饵（验证 userId 过滤真的起作用）
 *
 * ⚠️ 涉及外键的一个坑（写之前查了 pg_constraint）：
 *   Conversation.userId 有 FK 指向 User，所以诱饵不能凭空写一个 userId ——
 *   必须先造一个假 User 行，否则 INSERT 直接撞外键。
 *   反过来这也说明：C1 那条过滤不是可有可无的装饰。
 *
 * 用法：
 *   node scripts/seed-conversations.mjs                      # 列出知识库（看 id）
 *   node scripts/seed-conversations.mjs --kb=<id> --bulk=25   # 造 25 个会话
 *   node scripts/seed-conversations.mjs --kb=<id> --bait      # 造一条「别人」的会话
 *   node scripts/seed-conversations.mjs --clean               # 清掉本脚本造的全部数据
 *
 * 所有造出来的数据都带可识别前缀（标题 `[seed]` / userId `seed-bait-`），
 * 所以 --clean 不会碰到你的真实数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const TITLE_PREFIX = '[seed]';
const BAIT_USER_ID = 'seed-bait-user';
const BAIT_USER_EMAIL = 'seed-bait@example.invalid';

function loadEnv(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    let v = t.slice(i + 1).trim();
    const q = v[0];
    if (q === '"' || q === "'") {
      const end = v.indexOf(q, 1);
      v = end === -1 ? v.slice(1) : v.slice(1, end);
    } else {
      const hash = v.indexOf(' #');
      if (hash !== -1) v = v.slice(0, hash).trim();
    }
    out[t.slice(0, i).trim()] = v;
  }
  return out;
}

const args = process.argv.slice(2);
const get = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const has = (name) => args.includes(`--${name}`);

const env = loadEnv(path.resolve(process.cwd(), '.env.local'));
const url = env.DIRECT_URL;
if (!url) {
  console.error('❌ .env.local 里没有 DIRECT_URL');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: true },
  connectionTimeoutMillis: 15000,
});

await client.connect();

try {
  if (has('clean')) {
    const conversations = await client.query(
      `select id from "Conversation"
       where title like $1 or "userId" = $2`,
      [`${TITLE_PREFIX}%`, BAIT_USER_ID],
    );
    const ids = conversations.rows.map((r) => r.id);
    if (ids.length > 0) {
      await client.query(`delete from "Message" where "conversationId" = any($1)`, [ids]);
      await client.query(`delete from "Conversation" where id = any($1)`, [ids]);
    }
    await client.query(`delete from "User" where id = $1`, [BAIT_USER_ID]);
    console.log(`✅ 已清理 ${ids.length} 个 seed 会话 + 诱饵用户`);
  } else if (!get('kb')) {
    const { rows } = await client.query(
      `select k.id, k.name, count(c.id)::int as conversations
       from "KnowledgeBase" k left join "Conversation" c on c."kbId" = k.id
       group by k.id order by k."createdAt" desc`,
    );
    console.log('知识库列表（选一个 id 传给 --kb=）：\n');
    for (const r of rows) console.log(`  ${r.id}  ${r.name}  （${r.conversations} 个会话）`);
  } else {
    const kbId = get('kb');
    const kb = await client.query(`select id, name, "userId" from "KnowledgeBase" where id = $1`, [kbId]);
    if (kb.rowCount === 0) {
      console.error(`❌ 没有这个知识库：${kbId}`);
      process.exit(1);
    }
    const ownerId = kb.rows[0].userId;
    console.log(`目标知识库：${kb.rows[0].name}\n`);

    if (has('bulk')) {
      const n = Number(get('bulk') ?? 25);
      for (let i = 1; i <= n; i++) {
        const conv = await client.query(
          `insert into "Conversation"(id, title, "kbId", "userId", "createdAt", "updatedAt")
           values ($1, $2, $3, $4, now() - ($5 || ' minutes')::interval, now() - ($5 || ' minutes')::interval)
           returning id`,
          [`seedconv${String(i).padStart(3, '0')}`, `${TITLE_PREFIX} 测试会话 ${i}`, kbId, ownerId, String(i)],
        );
        await client.query(
          `insert into "Message"(id, role, content, "conversationId", "createdAt")
           values ($1, 'user', $2, $3, now()),
                  ($4, 'assistant', $5, $3, now() + interval '1 second')`,
          [
            `seedmsg${String(i).padStart(3, '0')}u`,
            `这是第 ${i} 个测试会话的问题`,
            conv.rows[0].id,
            `seedmsg${String(i).padStart(3, '0')}a`,
            `这是第 ${i} 个测试会话的回答。`,
          ],
        );
      }
      console.log(`✅ 已造 ${n} 个会话（标题 ${TITLE_PREFIX} …）`);
      console.log(`   现在去刷新 /kb/${kbId} —— 侧栏应该只显示 20 个，丢的是最老的 5 个。`);
    }

    if (has('bait')) {
      // 诱饵：同一个 kb（所以 URL 是对的），但 userId 是另一个人
      await client.query(
        `insert into "User"(id, name, email) values ($1, '诱饵用户', $2)
         on conflict (id) do nothing`,
        [BAIT_USER_ID, BAIT_USER_EMAIL],
      );
      const bait = await client.query(
        `insert into "Conversation"(id, title, "kbId", "userId")
         values ('seedbait', $1, $2, $3)
         on conflict (id) do update set title = excluded.title
         returning id`,
        [`${TITLE_PREFIX} 别人的秘密会话`, kbId, BAIT_USER_ID],
      );
      await client.query(
        `insert into "Message"(id, role, content, "conversationId")
         values ('seedbaitmsg', 'user', '这条消息属于别人，你不该看到它', $1)
         on conflict (id) do nothing`,
        [bait.rows[0].id],
      );
      console.log(`✅ 诱饵已就位：会话 id = seedbait`);
      console.log(`   验收 C1：浏览器打开 /kb/${kbId}?c=seedbait`);
      console.log(`   → 期望：页面右侧是空的（没有那条秘密消息），不是报错也不是别人的内容。`);
      console.log(`   → 反证：临时去掉 resolveConversation / loadConversationMessages 里的 userId 条件，`);
      console.log(`     重启后重新打开同一个 URL，必须能看到那条秘密消息。`);
      console.log(`     看不到 = 诱饵没生效，前面那个"绿"是假的。`);
    }

    if (!has('bulk') && !has('bait')) {
      console.log('什么也没做。加 --bulk=25 或 --bait。');
    }
  }
} finally {
  await client.end();
}
