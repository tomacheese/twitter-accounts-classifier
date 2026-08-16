-- reasonDistribution snapshot が AccountClassificationReasonCount を読むようになり、
-- AccountClassificationLatest への直接集計を行わなくなったため、#205 で追加した
-- この partial index は不要になった。残すと全 insert/update/delete で無駄な
-- index 更新コストだけが残る。CREATE INDEX CONCURRENTLY と同様、
-- DROP INDEX CONCURRENTLY もトランザクション外で実行できるよう1文だけに保つ。
DROP INDEX CONCURRENTLY IF EXISTS "AccountClassificationLatest_true_reason_idx";
