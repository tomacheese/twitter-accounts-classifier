-- AlterTable: 追加のみのため既定値付きで追加する。既存行は evaluable=false, labeledAt=null に
-- なり、新 sampling schema の bootstrap 完了 (account_summary_v2) までは
-- weekly review sampling の対象に含まれない fail-closed な移行にする。
ALTER TABLE "AccountClassificationLatest"
  ADD COLUMN "evaluable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "labeledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WeeklyReviewSampleBucketCount" (
    "labelDefinitionId" TEXT NOT NULL,
    "value" BOOLEAN NOT NULL,
    "bucket" INTEGER NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WeeklyReviewSampleBucketCount_pkey" PRIMARY KEY ("labelDefinitionId","value","bucket")
);

-- Account ID だけから 0..4095 の bucket を返す immutable 関数。
-- sha256 の先頭 32 bit を符号なし整数として読み、下位 12 bit をマスクして bucket にする。
-- run ID はここに含めない (bucket assignment は書き込み時に固定し、run ごとの
-- ランダム性は「どの bucket を読むか」側で与える)。
-- pgcrypto 拡張を追加せずに済むよう、PostgreSQL core の sha256() を使う。
CREATE OR REPLACE FUNCTION weekly_review_sample_bucket(account_id text)
RETURNS integer AS $$
  SELECT ('x' || substr(encode(sha256(convert_to(account_id, 'UTF8')), 'hex'), 1, 8))::bit(32)::int & 4095
$$ LANGUAGE sql IMMUTABLE;

-- AccountClassificationLatest への書き込みと同一トランザクション・同一行ロックの
-- 範囲内で WeeklyReviewSampleBucketCount を維持する。sampling eligibility
-- (evaluable = true AND labeledAt IS NOT NULL) が変化しない semantic field だけの
-- 更新では何もしない。eligibility が変化しない UPDATE で value も変わらない
-- 場合(evaluable/labeledAt だけの watermark 更新)も同様に何もしない。
-- 両方 eligible のまま value が flip する場合は、逆方向の flip と競合しても
-- 常に同じ順序でロックを取れるよう、(labelDefinitionId, value, bucket) の
-- value = false 側から先に処理する。
CREATE OR REPLACE FUNCTION weekly_review_sample_bucket_count_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_old_eligible BOOLEAN;
  v_new_eligible BOOLEAN;
  v_bucket INT;
BEGIN
  v_old_eligible := TG_OP IN ('UPDATE', 'DELETE') AND OLD."evaluable" AND OLD."labeledAt" IS NOT NULL;
  v_new_eligible := TG_OP IN ('UPDATE', 'INSERT') AND NEW."evaluable" AND NEW."labeledAt" IS NOT NULL;

  IF TG_OP = 'UPDATE' AND v_old_eligible = v_new_eligible
    AND (NOT v_old_eligible OR OLD."value" IS NOT DISTINCT FROM NEW."value")
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' AND NOT v_old_eligible THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' AND NOT v_new_eligible THEN
    RETURN NEW;
  END IF;

  v_bucket := weekly_review_sample_bucket(COALESCE(NEW."accountId", OLD."accountId"));

  IF v_old_eligible AND v_new_eligible THEN
    IF OLD."value" THEN
      INSERT INTO "WeeklyReviewSampleBucketCount" ("labelDefinitionId", "value", "bucket", "count")
        VALUES (NEW."labelDefinitionId", false, v_bucket, 1)
        ON CONFLICT ("labelDefinitionId", "value", "bucket") DO UPDATE SET
          "count" = "WeeklyReviewSampleBucketCount"."count" + 1;
      UPDATE "WeeklyReviewSampleBucketCount" SET "count" = "count" - 1
        WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "value" = true AND "bucket" = v_bucket;
      DELETE FROM "WeeklyReviewSampleBucketCount"
        WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "value" = true AND "bucket" = v_bucket AND "count" <= 0;
    ELSE
      UPDATE "WeeklyReviewSampleBucketCount" SET "count" = "count" - 1
        WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "value" = false AND "bucket" = v_bucket;
      DELETE FROM "WeeklyReviewSampleBucketCount"
        WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "value" = false AND "bucket" = v_bucket AND "count" <= 0;
      INSERT INTO "WeeklyReviewSampleBucketCount" ("labelDefinitionId", "value", "bucket", "count")
        VALUES (NEW."labelDefinitionId", true, v_bucket, 1)
        ON CONFLICT ("labelDefinitionId", "value", "bucket") DO UPDATE SET
          "count" = "WeeklyReviewSampleBucketCount"."count" + 1;
    END IF;
    RETURN NEW;
  END IF;

  IF v_old_eligible THEN
    UPDATE "WeeklyReviewSampleBucketCount" SET "count" = "count" - 1
      WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "value" = OLD."value" AND "bucket" = v_bucket;
    DELETE FROM "WeeklyReviewSampleBucketCount"
      WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "value" = OLD."value" AND "bucket" = v_bucket AND "count" <= 0;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  INSERT INTO "WeeklyReviewSampleBucketCount" ("labelDefinitionId", "value", "bucket", "count")
    VALUES (NEW."labelDefinitionId", NEW."value", v_bucket, 1)
    ON CONFLICT ("labelDefinitionId", "value", "bucket") DO UPDATE SET
      "count" = "WeeklyReviewSampleBucketCount"."count" + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER weekly_review_sample_bucket_count_trigger
  AFTER INSERT OR UPDATE OR DELETE ON "AccountClassificationLatest"
  FOR EACH ROW EXECUTE FUNCTION weekly_review_sample_bucket_count_trigger();
