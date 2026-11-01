-- W17：effectiveFrom 从 TIMESTAMP(3) 改成 TEXT
--
-- ⚠️ 目录名里的时间戳（071500）比同目录下的 20261101060422_w17_supersedes_raw 更晚，
-- 但这条是**手写**的（不是 prisma migrate dev 生成的），写成什么时间都不影响执行：
-- 它只操作 effectiveFrom 一个列，与 supersedesRaw 的 ADD COLUMN 无依赖关系。
--
-- 上一版迁移把它建成 TIMESTAMP(3)（Prisma DateTime 的默认映射，**不带时区**）。
-- 实测写入的是 UTC 字面值、读回来按本地 +08 解释，2026-01-01 存进去读出来是 2025-12-31。
-- 生效日期没有时分秒，用 timestamp 表达等于给它强加了一个不存在的时区维度。
--
-- 这一版没上线过（本地刚加、数据是刚回填的），所以直接 DROP + ADD，
-- 不做 USING 转换 —— 转出来的是带着 8 小时偏移的错误值，留着只会更糟。
ALTER TABLE "Document" DROP COLUMN "effectiveFrom",
ADD COLUMN "effectiveFrom" TEXT;
