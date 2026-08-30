-- recent tweets backfill 候補 selector を Account 起点の LATERAL join へ変更するにあたり、
-- lastRecentTweetsAttemptedAt IS NULL の行だけを走査できる部分 index を用意する。
-- 通常の Account_pkey では試行済み行も index に残り続け、
-- backfill 進行に応じて skip 量が増え続ける。
-- 部分 index なら試行済みになった行は index から消えるため、
-- スキャン量は未試行件数のみに比例する。
-- CREATE INDEX CONCURRENTLY を transaction 外で実行できるよう、1 文だけに保つ。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Account_recent_tweets_unattempted_idx"
ON "Account" ("id") WHERE "lastRecentTweetsAttemptedAt" IS NULL;
