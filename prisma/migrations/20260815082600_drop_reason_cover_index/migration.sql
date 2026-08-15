-- 全行を保持する旧 covering index は本番で idx_scan=0 であり、新しい value=true partial index に置き換える。
-- DROP INDEX CONCURRENTLY を transaction 外で実行できるよう、1 文だけに保つ。
DROP INDEX CONCURRENTLY IF EXISTS "AccountClassificationLatest_label_value_reason_cover_idx";
