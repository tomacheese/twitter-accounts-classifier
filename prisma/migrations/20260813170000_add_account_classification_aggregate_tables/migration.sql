-- CreateTable
CREATE TABLE "AccountClassificationValueCount" (
    "labelDefinitionId" TEXT NOT NULL,
    "value" BOOLEAN NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "confidenceSum" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "AccountClassificationValueCount_pkey" PRIMARY KEY ("labelDefinitionId","value")
);

-- CreateTable
CREATE TABLE "AccountClassificationConfidenceBucketCount" (
    "labelDefinitionId" TEXT NOT NULL,
    "confidenceBucket" INTEGER NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AccountClassificationConfidenceBucketCount_pkey" PRIMARY KEY ("labelDefinitionId","confidenceBucket")
);

-- CreateTable
CREATE TABLE "AccountClassificationRuleVersionCount" (
    "labelDefinitionId" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AccountClassificationRuleVersionCount_pkey" PRIMARY KEY ("labelDefinitionId","ruleVersion")
);

-- CreateTable
CREATE TABLE "AccountClassificationFreshnessBucket" (
    "labelDefinitionId" TEXT NOT NULL,
    "observedAtBucket" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AccountClassificationFreshnessBucket_pkey" PRIMARY KEY ("labelDefinitionId","observedAtBucket")
);

-- AccountClassificationLatest への書き込みと同一トランザクション・同一行ロックの
-- 範囲内で4集計テーブルを維持する。アプリケーション層での read-modify-write では
-- 並行 upsert 時に stale な値を減算してしまうため、トリガーで行ロックと遷移の
-- 確定を同一 SQL 文にまとめる。
CREATE OR REPLACE FUNCTION account_classification_latest_aggregate_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_sentinel CONSTANT TIMESTAMP := TIMESTAMP '1970-01-01';
  v_ceiling CONSTANT INTERVAL := INTERVAL '7 days';
  v_confidence_bucket_old INT;
  v_confidence_bucket_new INT;
  v_literal_old_bucket TIMESTAMP;
  v_literal_new_bucket TIMESTAMP;
BEGIN
  -- sentinel 行を(無ければ)作ってから常に先にロックする。compaction・OLD/NEW
  -- いずれの分岐でもこの順序を守ることで、逆順ロックによるデッドロックを
  -- 構造的に排除する。
  INSERT INTO "AccountClassificationFreshnessBucket" ("labelDefinitionId", "observedAtBucket", "count")
    VALUES (NEW."labelDefinitionId", v_sentinel, 0)
    ON CONFLICT DO NOTHING;
  PERFORM 1 FROM "AccountClassificationFreshnessBucket"
    WHERE "labelDefinitionId" = NEW."labelDefinitionId" AND "observedAtBucket" = v_sentinel
    FOR UPDATE;

  IF TG_OP = 'UPDATE' THEN
    v_confidence_bucket_old := LEAST(FLOOR(OLD."confidence" * 10), 9)::int;

    UPDATE "AccountClassificationValueCount"
      SET "count" = "count" - 1, "confidenceSum" = "confidenceSum" - OLD."confidence"
      WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "value" = OLD."value";
    DELETE FROM "AccountClassificationValueCount"
      WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "value" = OLD."value" AND "count" <= 0;

    UPDATE "AccountClassificationConfidenceBucketCount"
      SET "count" = "count" - 1
      WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "confidenceBucket" = v_confidence_bucket_old;
    DELETE FROM "AccountClassificationConfidenceBucketCount"
      WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "confidenceBucket" = v_confidence_bucket_old
        AND "count" <= 0;

    UPDATE "AccountClassificationRuleVersionCount"
      SET "count" = "count" - 1
      WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "ruleVersion" = OLD."ruleVersion";
    DELETE FROM "AccountClassificationRuleVersionCount"
      WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "ruleVersion" = OLD."ruleVersion"
        AND "count" <= 0;

    -- freshness バケットの decrement 対象は、OLD の実際の物理的な所属先を
    -- 確認してから決める。now() だけを基準に「本来あるべきバケット」を
    -- 再計算してはならない(compaction が丸め込んだかどうかは書き込み側からは
    -- 分からないため)。
    v_literal_old_bucket := date_trunc('minute', OLD."observedAt");
    IF EXISTS (
      SELECT 1 FROM "AccountClassificationFreshnessBucket"
        WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "observedAtBucket" = v_literal_old_bucket
        FOR UPDATE
    ) THEN
      UPDATE "AccountClassificationFreshnessBucket"
        SET "count" = "count" - 1
        WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "observedAtBucket" = v_literal_old_bucket;
      DELETE FROM "AccountClassificationFreshnessBucket"
        WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "observedAtBucket" = v_literal_old_bucket
          AND "count" <= 0;
    ELSE
      UPDATE "AccountClassificationFreshnessBucket"
        SET "count" = "count" - 1
        WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "observedAtBucket" = v_sentinel;
    END IF;
  END IF;

  v_confidence_bucket_new := LEAST(FLOOR(NEW."confidence" * 10), 9)::int;

  INSERT INTO "AccountClassificationValueCount" ("labelDefinitionId", "value", "count", "confidenceSum")
    VALUES (NEW."labelDefinitionId", NEW."value", 1, NEW."confidence")
    ON CONFLICT ("labelDefinitionId", "value") DO UPDATE SET
      "count" = "AccountClassificationValueCount"."count" + 1,
      "confidenceSum" = "AccountClassificationValueCount"."confidenceSum" + NEW."confidence";

  INSERT INTO "AccountClassificationConfidenceBucketCount" ("labelDefinitionId", "confidenceBucket", "count")
    VALUES (NEW."labelDefinitionId", v_confidence_bucket_new, 1)
    ON CONFLICT ("labelDefinitionId", "confidenceBucket") DO UPDATE SET
      "count" = "AccountClassificationConfidenceBucketCount"."count" + 1;

  INSERT INTO "AccountClassificationRuleVersionCount" ("labelDefinitionId", "ruleVersion", "count")
    VALUES (NEW."labelDefinitionId", NEW."ruleVersion", 1)
    ON CONFLICT ("labelDefinitionId", "ruleVersion") DO UPDATE SET
      "count" = "AccountClassificationRuleVersionCount"."count" + 1;

  -- freshness バケットの increment 対象も OLD と対称に、実際の物理的な所属先を
  -- 確認してから決める。既存バケットが存在すれば年齢に関わらずそこへ加算し、
  -- 同一分単位バケットの量がバケット行と sentinel に分裂することを防ぐ。
  -- 存在しない場合のみ年齢基準で振り分ける。
  v_literal_new_bucket := date_trunc('minute', NEW."observedAt");
  IF EXISTS (
    SELECT 1 FROM "AccountClassificationFreshnessBucket"
      WHERE "labelDefinitionId" = NEW."labelDefinitionId" AND "observedAtBucket" = v_literal_new_bucket
      FOR UPDATE
  ) THEN
    UPDATE "AccountClassificationFreshnessBucket"
      SET "count" = "count" + 1
      WHERE "labelDefinitionId" = NEW."labelDefinitionId" AND "observedAtBucket" = v_literal_new_bucket;
  ELSIF now() - NEW."observedAt" > v_ceiling THEN
    UPDATE "AccountClassificationFreshnessBucket"
      SET "count" = "count" + 1
      WHERE "labelDefinitionId" = NEW."labelDefinitionId" AND "observedAtBucket" = v_sentinel;
  ELSE
    INSERT INTO "AccountClassificationFreshnessBucket" ("labelDefinitionId", "observedAtBucket", "count")
      VALUES (NEW."labelDefinitionId", v_literal_new_bucket, 1);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER account_classification_latest_aggregate_trigger
  AFTER INSERT OR UPDATE ON "AccountClassificationLatest"
  FOR EACH ROW EXECUTE FUNCTION account_classification_latest_aggregate_trigger();

-- reasonDistribution を value = true に絞った index-only scan にするため、
-- 既存 index を reason を INCLUDE した同名の index に差し替える。
-- Prisma schema の @@index([labelDefinitionId, value, accountId]) はそのままでよく、
-- INCLUDE 句は既存の GIN index と同様に Prisma schema には表現しない raw SQL 側だけの
-- 変更とする。
DROP INDEX IF EXISTS "AccountClassificationLatest_labelDefinitionId_value_account_idx";
CREATE INDEX "AccountClassificationLatest_labelDefinitionId_value_account_idx"
  ON "AccountClassificationLatest" ("labelDefinitionId", "value") INCLUDE ("accountId", "reason");

-- 既存データの backfill。CREATE TRIGGER (上記) が取得するロックにより、この
-- migration トランザクションがコミットするまで AccountClassificationLatest への
-- 書き込みはブロックされるため、backfill が読む「トリガー作成前の状態」と
-- コミット後にトリガーが捕捉し始める「以降の書き込み」の間に隙間はできない。
INSERT INTO "AccountClassificationValueCount" ("labelDefinitionId", "value", "count", "confidenceSum")
SELECT "labelDefinitionId", "value", COUNT(*), SUM("confidence")
FROM "AccountClassificationLatest" GROUP BY 1, 2;

INSERT INTO "AccountClassificationConfidenceBucketCount" ("labelDefinitionId", "confidenceBucket", "count")
SELECT "labelDefinitionId", LEAST(FLOOR("confidence" * 10), 9)::int, COUNT(*)
FROM "AccountClassificationLatest" GROUP BY 1, 2;

INSERT INTO "AccountClassificationRuleVersionCount" ("labelDefinitionId", "ruleVersion", "count")
SELECT "labelDefinitionId", "ruleVersion", COUNT(*)
FROM "AccountClassificationLatest" GROUP BY 1, 2;

INSERT INTO "AccountClassificationFreshnessBucket" ("labelDefinitionId", "observedAtBucket", "count")
SELECT
  "labelDefinitionId",
  CASE WHEN now() - "observedAt" > interval '7 days'
    THEN TIMESTAMP '1970-01-01'
    ELSE date_trunc('minute', "observedAt")
  END,
  COUNT(*)
FROM "AccountClassificationLatest" GROUP BY 1, 2;
