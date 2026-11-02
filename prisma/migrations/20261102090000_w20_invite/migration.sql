-- W20：邀请表
--
-- 新表、无存量数据，所以不需要 W19 那套"加可空列 → 回填 → 收紧"的顺序。
-- 但仍然手写而不是 migrate dev 生成：本机 Prisma CLI 依赖代理出网（P1001 排查顺序见
-- 工作日志），新表迁移用 Node+pg 直连应用 + 手工登记 _prisma_migrations 即可，
-- SQL 结构与 Prisma 会生成的完全一致（TIMESTAMP(3)、命名约定都对齐 W19 迁移）。
--
-- createdBy / consumedBy 不设外键：纯审计字段，与 KnowledgeBase.createdBy 同款约定。

CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "tokenHash" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");
CREATE INDEX "Invite_orgId_idx" ON "Invite"("orgId");

ALTER TABLE "Invite" ADD CONSTRAINT "Invite_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
