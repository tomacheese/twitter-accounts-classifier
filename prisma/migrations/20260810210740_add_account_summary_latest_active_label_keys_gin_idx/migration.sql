-- activeLabelKeys (text[]) への GIN index が無いと、label filter (&& 演算子) は
-- normalizedScreenName の並び順維持スキャン後の後段フィルタとして適用され、
-- 本番規模の行数では極端に遅くなる。text[] への GIN index は既定の array ops で
-- && をサポートするため、追加のオペレータクラス指定は不要。
-- CREATE INDEX CONCURRENTLY を transaction 外で実行できるよう、1 文だけに保つ。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AccountSummaryLatest_activeLabelKeys_gin_idx"
  ON "AccountSummaryLatest" USING GIN ("activeLabelKeys");
