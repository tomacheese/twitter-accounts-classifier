-- crawl 経路が classification snapshot を保持できるようにする。
-- 両方 nullable のため既存行への backfill は不要。
ALTER TABLE "AccountClassificationObservation"
  ADD COLUMN "snapshotVersion" INTEGER,
  ADD COLUMN "classificationSnapshot" JSONB;

-- gen_random_uuid() は PostgreSQL 13 以降 pg_catalog に組み込みのため、
-- pgcrypto extension の作成は不要 (権限要求を増やすだけになる)。

-- AccountLabelLatest への書き込みを契機に AccountLabelChange を自動生成するトリガー。
-- relabel が Observation を作らないため、relabel 由来の value 変化を捕捉できるのは
-- このトリガーだけである。
CREATE OR REPLACE FUNCTION account_label_latest_change_audit()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."value" = true THEN
      INSERT INTO "AccountLabelChange"
        ("id", "accountId", "labelDefinitionId", "changeType",
         "previousValue", "newValue", "previousConfidence", "newConfidence",
         "previousReason", "newReason", "sourceId", "changedAt")
      VALUES
        (gen_random_uuid()::text, NEW."accountId", NEW."labelDefinitionId", 'added',
         NULL, NEW."value", NULL, NEW."confidence",
         NULL, NEW."reason", NEW."sourceId", NEW."labeledAt")
      ON CONFLICT ("accountId", "labelDefinitionId", "changedAt") DO NOTHING;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD."value" IS DISTINCT FROM NEW."value" THEN
      INSERT INTO "AccountLabelChange"
        ("id", "accountId", "labelDefinitionId", "changeType",
         "previousValue", "newValue", "previousConfidence", "newConfidence",
         "previousReason", "newReason", "sourceId", "changedAt")
      VALUES
        (gen_random_uuid()::text, NEW."accountId", NEW."labelDefinitionId",
         CASE WHEN NEW."value" THEN 'added' ELSE 'removed' END,
         OLD."value", NEW."value", OLD."confidence", NEW."confidence",
         OLD."reason", NEW."reason", NEW."sourceId", NEW."labeledAt")
      ON CONFLICT ("accountId", "labelDefinitionId", "changedAt") DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER account_label_latest_change_audit_trigger
AFTER INSERT OR UPDATE ON "AccountLabelLatest"
FOR EACH ROW EXECUTE FUNCTION account_label_latest_change_audit();

-- storage-guard が計測したホストファイルシステムの空き容量・使用率を保持する単一行テーブル。
CREATE TABLE "StorageCapacityState" (
  "id" TEXT NOT NULL,
  "availableGib" DOUBLE PRECISION NOT NULL,
  "usedPercent" INTEGER NOT NULL,
  "measuredAt" TIMESTAMP(3) NOT NULL,
  "relabelBlocked" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "StorageCapacityState_pkey" PRIMARY KEY ("id")
);
