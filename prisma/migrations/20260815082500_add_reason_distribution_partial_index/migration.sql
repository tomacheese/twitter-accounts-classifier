-- 全ラベルを対象にした reasonDistribution では labelDefinitionId の選択性が無くなるため、既存の全行 covering index は planner に選ばれない。
-- value=true の行だけを保持し、GROUP BY のキーと同じ順序で読む小さい index に限定する。
-- CREATE INDEX CONCURRENTLY を transaction 外で実行できるよう、1 文だけに保つ。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AccountClassificationLatest_true_reason_idx"
ON "AccountClassificationLatest" ("labelDefinitionId", "reason") WHERE "value" = true;
