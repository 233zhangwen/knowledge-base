-- W21：组织月度问答额度
--
-- 一列、可空、无默认值：null 表示"用环境默认"（MONTHLY_ANSWER_QUOTA，默认 500）。
-- 不存已用量（现算，见 quota.ts），所以没有回填、没有 NOT NULL 收紧 ——
-- 迁移只有一件事可做，也就只有一件事可能错。

ALTER TABLE "Organization" ADD COLUMN "monthlyAnswerQuota" INTEGER;
