-- reasonDistribution snapshot は AccountClassificationReasonCount を読むようになり、
-- AccountClassificationLatest への直接集計をしなくなったため、この partial index は
-- 不要になった。残すと全 insert/update/delete で無駄な index 更新コストだけが残る。
-- CREATE INDEX CONCURRENTLY と同様、
-- DROP INDEX CONCURRENTLY もトランザクション外で実行できるよう1文だけに保つ。
DROP INDEX CONCURRENTLY IF EXISTS "AccountClassificationLatest_true_reason_idx";
