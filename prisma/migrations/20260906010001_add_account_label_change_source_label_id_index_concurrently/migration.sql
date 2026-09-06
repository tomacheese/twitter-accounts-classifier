-- sourceLabelId は legacy snapshotless analyzer の冪等キー (raw AccountLabel.id)。
-- CREATE UNIQUE INDEX CONCURRENTLY を transaction 外で実行できるよう、1 文だけに保つ。
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "AccountLabelChange_sourceLabelId_key"
  ON "AccountLabelChange"("sourceLabelId");
