/**
 * 越权隔离验证 —— 不需要第二个 GitHub 账号
 *
 * 用法：
 *   node scripts/verify-isolation.mjs            # 造数据 + 跑攻击探针
 *   node scripts/verify-isolation.mjs --cleanup  # 清掉造出来的数据
 *
 * 为什么需要这个脚本：
 *   验证「用户 A 看不到 / 改不动 用户 B 的知识库」最直接的办法是登两个账号，
 *   但 GitHub 小号不是随手就有的。那就绕开登录，直接在库里放一份「别人的数据」：
 *     - 读隔离：浏览器刷新 /kb，那份数据不该出现在列表里
 *     - 写隔离：用当前真实用户的 id 去碰它，应当 0 行受影响
 *
 * 关键设计：探针用的 SQL 条件必须和 src/app/kb/actions.ts 里**一模一样**
 *   （WHERE id = $1 AND "userId" = $2）。条件抄错就变成了测另一个东西。
 *
 * 还有一个「反证」：同样一条 UPDATE，去掉 "userId" 条件后会成功改掉别人的数据。
 *   这一步是为了证明**真正拦住攻击的是那个 userId 条件**，
 *   而不是「碰巧没人这么干」。没有反证的测试，通过了也说明不了什么。
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

function loadEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = loadEnv(path.resolve(process.cwd(), '.env.local'));
const DB_URL = env.DATABASE_URL;
if (!DB_URL) {
  console.error('❌ .env.local 里没有 DATABASE_URL');
  process.exit(1);
}

const VICTIM_USER_ID = 'dev-seed-other-user';
const VICTIM_EMAIL = 'other@dev.local';
const VICTIM_KB_ID = 'dev-seed-other-kb';
const VICTIM_KB_NAME = '别人的知识库（你不该看见这个）';
const BAIT_KB_ID = 'dev-seed-bait-kb';
const BAIT_KB_NAME = '诱饵：用来演示漏条件会怎样';

const cleanupOnly = process.argv.includes('--cleanup');

const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

const log = (...a) => console.log(...a);
const pass = (m) => log(`  ✅ ${m}`);
const fail = (m) => log(`  ❌ ${m}`);
let failed = 0;

async function seed() {
  // 幂等：先删再插，重复跑不会报 unique 冲突
  await client.query(`DELETE FROM "User" WHERE id = $1`, [VICTIM_USER_ID]);
  await client.query(
    `INSERT INTO "User" (id, name, email) VALUES ($1, $2, $3)`,
    [VICTIM_USER_ID, '别人（种子数据）', VICTIM_EMAIL]
  );
  await client.query(
    `INSERT INTO "KnowledgeBase" (id, name, description, "updatedAt", "userId")
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)`,
    [VICTIM_KB_ID, VICTIM_KB_NAME, '由 verify-isolation.mjs 生成，可随时删', VICTIM_USER_ID]
  );
  // 诱饵：专门用来演示「去掉 userId 条件」会发生什么
  await client.query(
    `INSERT INTO "KnowledgeBase" (id, name, description, "updatedAt", "userId")
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)`,
    [BAIT_KB_ID, BAIT_KB_NAME, '诱饵数据', VICTIM_USER_ID]
  );
}

async function cleanup() {
  // User 上的外键是 ON DELETE CASCADE，删用户会带走他的 KnowledgeBase
  await client.query(`DELETE FROM "User" WHERE id = $1`, [VICTIM_USER_ID]);
  await client.query(`DELETE FROM "KnowledgeBase" WHERE id = ANY($1)`, [[VICTIM_KB_ID, BAIT_KB_ID]]);
}

async function main() {
  await client.connect();
  await client.query('SELECT 1');

  if (cleanupOnly) {
    await cleanup();
    log('🧹 已清理种子数据');
    return;
  }

  log('\n=== 1. 库里现有用户 ===');
  const users = await client.query(
    `SELECT u.id, u.name, u.email, COUNT(k.id)::int AS kb_count
       FROM "User" u LEFT JOIN "KnowledgeBase" k ON k."userId" = u.id
      GROUP BY u.id, u.name, u.email ORDER BY kb_count DESC`
  );
  for (const u of users.rows) {
    log(`  ${u.id}  ${u.email ?? '(无邮箱)'}  知识库 ${u.kb_count} 个`);
  }

  const realUsers = users.rows.filter((u) => u.id !== VICTIM_USER_ID);
  if (realUsers.length === 0) {
    console.error('\n❌ 库里没有真实用户，先在浏览器登录一次再跑这个脚本');
    process.exitCode = 1;
    return;
  }

  log('\n=== 2. 造一份「别人的数据」 ===');
  await seed();
  pass(`已插入 用户 ${VICTIM_EMAIL} + 知识库「${VICTIM_KB_NAME}」`);

  log('\n=== 3. 读隔离（需要你手动看一眼浏览器）===');
  log(`  现在去刷新 http://localhost:3000/kb`);
  log(`  列表里**不应该**出现「${VICTIM_KB_NAME}」`);
  log(`  出现了 = 查询漏了 userId 条件 = 数据泄露`);
  log('  （这一条脚本没法替你判，必须你自己看）');

  log('\n=== 4. 写隔离：拿真实用户身份去攻击别人的知识库 ===');
  for (const u of realUsers) {
    const upd = await client.query(
      `UPDATE "KnowledgeBase" SET name = 'hacked', "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = $1 AND "userId" = $2`,
      [VICTIM_KB_ID, u.id]
    );
    upd.rowCount === 0
      ? pass(`改别人：${u.email ?? u.id} → 0 行受影响（被拦住）`)
      : (fail(`改别人：${u.email ?? u.id} → 改了 ${upd.rowCount} 行（越权！）`), failed++);

    const del = await client.query(
      `DELETE FROM "KnowledgeBase" WHERE id = $1 AND "userId" = $2`,
      [VICTIM_KB_ID, u.id]
    );
    del.rowCount === 0
      ? pass(`删别人：${u.email ?? u.id} → 0 行受影响（被拦住）`)
      : (fail(`删别人：${u.email ?? u.id} → 删了 ${del.rowCount} 行（越权！）`), failed++);
  }

  const still = await client.query(`SELECT name FROM "KnowledgeBase" WHERE id = $1`, [VICTIM_KB_ID]);
  still.rowCount === 1 && still.rows[0].name === VICTIM_KB_NAME
    ? pass('受害者数据仍完好无损')
    : (fail('受害者数据被改写或删除了'), failed++);

  log('\n=== 5. 反证：去掉 userId 条件会发生什么 ===');
  const attacker = realUsers[0];
  const bad = await client.query(
    `UPDATE "KnowledgeBase" SET name = 'hacked-without-userId', "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [BAIT_KB_ID]
  );
  bad.rowCount === 1
    ? pass(`反证成立：同一句 UPDATE 去掉 userId 条件 → 成功改掉 ${bad.rowCount} 行别人的数据`)
    : (fail('反证失败（预期能改到，实际没改到）—— 说明探针本身有问题'), failed++);

  const bait = await client.query(`SELECT name FROM "KnowledgeBase" WHERE id = $1`, [BAIT_KB_ID]);
  log(`  诱饵现在的名字：「${bait.rows[0]?.name}」← 这就是攻击者改别人的效果`);
  log(`  （攻击者身份：${attacker.email ?? attacker.id}）`);

  log('\n=== 6. 收尾 ===');
  await client.query(`DELETE FROM "KnowledgeBase" WHERE id = $1`, [BAIT_KB_ID]);
  pass('诱饵已删除');
  log(`\n种子数据保留着，方便你再刷一次页面确认列表干净。`);
  log(`清理：node scripts/verify-isolation.mjs --cleanup`);

  log(
    failed === 0
      ? '\n✅ 全部通过：写隔离有效，且证明了拦住攻击的正是那个 userId 条件\n'
      : `\n❌ 有 ${failed} 项失败，检查 actions.ts 里的 where 条件\n`
  );
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('脚本出错：', e.message);
    process.exitCode = 1;
  })
  .finally(() => client.end().catch(() => {}));
