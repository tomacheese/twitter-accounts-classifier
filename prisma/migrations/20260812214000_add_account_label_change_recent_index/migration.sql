-- weekly review は対象期間の変更を新しい順に少数だけ必要とする。
-- CREATE INDEX CONCURRENTLY を transaction 外で実行できるよう、1 文だけに保つ。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AccountLabelChange_changedAt_id_idx"
ON "AccountLabelChange" ("changedAt" DESC, "id" DESC);
