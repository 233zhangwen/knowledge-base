-- W19：租户边界从「用户」抬到「组织」
--
-- 为什么是手写的，不是 migrate dev 生成的：
--   自动生成的 SQL 会 `ALTER TABLE ... ADD COLUMN "orgId" TEXT NOT NULL` —— 表里有数据，
--   加非空列必然失败；它还会直接 `DROP COLUMN "userId"` —— 回填之前就 drop，数据没了。
--   正确顺序只能是：建表 → 加可空列 → 回填 → 收紧。这个顺序不是 Prisma 能猜出来的。
--
-- 为什么不做 IF NOT EXISTS 式的伪幂等：迁移只跑一次（Prisma 用 checksum 记录）。
--   写成"重复执行也成功"会掩盖状态不一致 —— 真出问题时它会静默跳过，而不是报错。

-- ============================================================
-- 1. 建表
-- ============================================================

CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'owner',
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Membership_orgId_idx" ON "Membership"("orgId");
CREATE UNIQUE INDEX "Membership_userId_orgId_key" ON "Membership"("userId", "orgId");

ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 2. 加可空列（此时还不设 NOT NULL —— 表里已经有数据）
-- ============================================================

ALTER TABLE "KnowledgeBase" ADD COLUMN "orgId" TEXT;
ALTER TABLE "KnowledgeBase" ADD COLUMN "createdBy" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "orgId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "createdBy" TEXT;

-- ============================================================
-- 3. 回填：每个存量用户 → 一个默认组织 + 一条 owner 成员记录
--
-- 为什么用 DO 块逐行处理而不是一条 INSERT ... SELECT + UPDATE：
--   组织 id 是每行新生成的，还要在同一轮里被下一步用到。用 SQL 关联回填得靠
--   "名字"之类的业务字段做 join —— 两个用户同名就会把数据挂错组织，而挂错
--   比报错难查得多（功能全正常，只是数据落到别人那里去了）。
--
-- 这一段是整周唯一不可回滚的操作。所以下一段有断言，宁可让迁移失败也不带病提交。
-- ============================================================

DO $$
DECLARE
  u RECORD;
  new_org_id TEXT;
BEGIN
  FOR u IN SELECT id, name, email FROM "User" LOOP
    new_org_id := 'org_' || replace(gen_random_uuid()::text, '-', '');

    INSERT INTO "Organization" ("id", "name", "createdAt")
    VALUES (
      new_org_id,
      coalesce(nullif(u.name, ''), u.email, '个人') || ' 的空间',
      now()
    );

    INSERT INTO "Membership" ("id", "role", "userId", "orgId", "createdAt")
    VALUES (
      'mem_' || replace(gen_random_uuid()::text, '-', ''),
      'owner',
      u.id,
      new_org_id,
      now()
    );

    UPDATE "KnowledgeBase"
       SET "orgId" = new_org_id, "createdBy" = u.id
     WHERE "userId" = u.id;

    UPDATE "Conversation"
       SET "orgId" = new_org_id, "createdBy" = u.id
     WHERE "userId" = u.id;
  END LOOP;
END $$;

-- ============================================================
-- 4. 收紧前断言
--
-- 任何一行没回填到，就让整个迁移失败。有两条理由：
--   1. 后面紧接着 SET NOT NULL，如果漏了行，Postgres 自己也会报错 ——
--      但那时报的是"某列含 null"，看不出是哪张表、漏了多少行。
--   2. 更隐蔽的情况是：表恰好为空，SET NOT NULL 成功，问题被推迟到第一次写入。
-- 主动断言一次，报错点就在出问题的地方。
-- ============================================================

DO $$
DECLARE
  bad_kb INT;
  bad_conv INT;
BEGIN
  SELECT count(*) INTO bad_kb FROM "KnowledgeBase" WHERE "orgId" IS NULL OR "createdBy" IS NULL;
  IF bad_kb > 0 THEN
    RAISE EXCEPTION 'KnowledgeBase 有 % 行未回填，迁移中止', bad_kb;
  END IF;

  SELECT count(*) INTO bad_conv FROM "Conversation" WHERE "orgId" IS NULL OR "createdBy" IS NULL;
  IF bad_conv > 0 THEN
    RAISE EXCEPTION 'Conversation 有 % 行未回填，迁移中止', bad_conv;
  END IF;
END $$;

-- ============================================================
-- 5. 收紧 + 删旧列
-- ============================================================

ALTER TABLE "KnowledgeBase" ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "KnowledgeBase" ALTER COLUMN "createdBy" SET NOT NULL;
ALTER TABLE "Conversation" ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "Conversation" ALTER COLUMN "createdBy" SET NOT NULL;

-- userId 的外键约束随列一起删除（Postgres 会连带删除该列上的约束）
ALTER TABLE "KnowledgeBase" DROP COLUMN "userId";
ALTER TABLE "Conversation" DROP COLUMN "userId";

ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
