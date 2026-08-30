-- block candidate selector は対象 label ごとの currentRuleVersion・confidence threshold で
-- 絞り込んだ少数の適格行だけを読めばよいが、既存 index では labelDefinitionId/ruleVersion と
-- value=true 全体の bitmap を別々に持つため、両者の BitmapAnd で value=true 全体
-- (146M row table のうち約 1.8M rows) を経由してしまう。
-- labelDefinitionId・ruleVersion の等値条件と confidence の範囲条件を Index Cond として
-- 満たす複合部分 index にし、accountId を末尾に含めて anti-join 判定を index-only scan で
-- 完結させる。DISTINCT ON (accountId) の並び替えまではこの index だけでは満たせない。
-- CREATE INDEX CONCURRENTLY を transaction 外で実行できるよう、1 文だけに保つ。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AccountLabelLatest_block_candidate_idx"
ON "AccountLabelLatest" ("labelDefinitionId", "ruleVersion", "confidence" DESC, "accountId")
WHERE "value" = true;
