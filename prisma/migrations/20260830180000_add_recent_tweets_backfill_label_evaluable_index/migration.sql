-- recent tweets backfill 候補 selector は対象 4 ラベルの evaluable=false 行だけを読む。
-- labelDefinitionId を先頭に置く既存 index が無く、全行を対象にした複合 index は肥大化するため、
-- evaluable=false 行だけに絞った部分 index にする。
-- CREATE INDEX CONCURRENTLY を transaction 外で実行できるよう、1 文だけに保つ。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AccountLabelLatest_backfill_label_evaluable_idx"
ON "AccountLabelLatest" ("labelDefinitionId", "accountId") WHERE "evaluable" = false;
