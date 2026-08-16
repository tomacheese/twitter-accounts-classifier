-- CreateTable
CREATE TABLE "AccountClassificationReasonCount" (
    "labelDefinitionId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AccountClassificationReasonCount_pkey" PRIMARY KEY ("labelDefinitionId","reason")
);

-- AccountClassificationLatest への書き込みと同一トランザクション・同一行ロックの
-- 範囲内で5集計テーブルを維持する。アプリケーション層での read-modify-write では
-- 並行 upsert 時に stale な値を減算してしまうため、トリガーで行ロックと遷移の
-- 確定を同一 SQL 文にまとめる。
-- "observedAt"/"observedAtBucket" は TIMESTAMP (timezone なし) で UTC の
-- wall-clock 値として扱う運用のため、timestamptz を返す now() と直接比較すると
-- セッションの timezone 設定に応じて implicit cast がずれる。now() は必ず
-- AT TIME ZONE 'UTC' で naive UTC に変換してから比較する。
-- reasonDistribution snapshot が AccountClassificationLatest を直接 GROUP BY せずに
-- 済むよう、value=true 行専用の reason count を他4集計テーブルと同じトリガーで
-- 維持する。value=false の reason は snapshot 側で使われないため保持しない。
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
  -- 5集計テーブルに影響する列 (value/confidence/ruleVersion/reason と、分単位に
  -- 丸めた observedAt) が UPDATE 前後で変わらないなら、decrement/increment は
  -- 差し引きゼロにしかならない。単なる再クロールで observedAt が同一分内で
  -- 微増するだけの多発ケースで、不要な行ロックを取らずに済ませる。
  IF TG_OP = 'UPDATE'
    AND NEW."value" IS NOT DISTINCT FROM OLD."value"
    AND NEW."confidence" IS NOT DISTINCT FROM OLD."confidence"
    AND NEW."ruleVersion" IS NOT DISTINCT FROM OLD."ruleVersion"
    AND NEW."reason" IS NOT DISTINCT FROM OLD."reason"
    AND date_trunc('minute', NEW."observedAt") IS NOT DISTINCT FROM date_trunc('minute', OLD."observedAt")
  THEN
    RETURN NEW;
  END IF;

  -- sentinel 行を(無ければ)作ってから常に先にロックする。compaction・OLD/NEW
  -- いずれの分岐でもこの順序を守ることで、逆順ロックによるデッドロックを
  -- 構造的に排除する。DELETE では NEW が存在しないため OLD を使う。
  INSERT INTO "AccountClassificationFreshnessBucket" ("labelDefinitionId", "observedAtBucket", "count")
    VALUES (COALESCE(NEW."labelDefinitionId", OLD."labelDefinitionId"), v_sentinel, 0)
    ON CONFLICT DO NOTHING;
  PERFORM 1 FROM "AccountClassificationFreshnessBucket"
    WHERE "labelDefinitionId" = COALESCE(NEW."labelDefinitionId", OLD."labelDefinitionId")
      AND "observedAtBucket" = v_sentinel
    FOR UPDATE;

  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
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

    -- reasonDistribution が対象にするのは value=true 行だけなので、
    -- OLD が true だった場合のみ減算する。
    IF OLD."value" THEN
      UPDATE "AccountClassificationReasonCount"
        SET "count" = "count" - 1
        WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "reason" = OLD."reason";
      DELETE FROM "AccountClassificationReasonCount"
        WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "reason" = OLD."reason"
          AND "count" <= 0;
    END IF;

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

  -- DELETE は OLD の decrement のみで完結し、INSERT 相当の増分は行わない。
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
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

  -- reasonDistribution が対象にするのは value=true 行だけなので、
  -- NEW が true の場合のみ加算する。
  IF NEW."value" THEN
    INSERT INTO "AccountClassificationReasonCount" ("labelDefinitionId", "reason", "count")
      VALUES (NEW."labelDefinitionId", NEW."reason", 1)
      ON CONFLICT ("labelDefinitionId", "reason") DO UPDATE SET
        "count" = "AccountClassificationReasonCount"."count" + 1;
  END IF;

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
  ELSIF (now() AT TIME ZONE 'UTC') - NEW."observedAt" > v_ceiling THEN
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

-- 既存データの backfill。CREATE OR REPLACE FUNCTION (上記) がコミットされるまで
-- 新関数は有効にならないが、本 migration はトランザクション内で実行されるため、
-- 関数置き換えと backfill の間に別接続からの書き込みが commit されることはない。
INSERT INTO "AccountClassificationReasonCount" ("labelDefinitionId", "reason", "count")
SELECT "labelDefinitionId", "reason", COUNT(*)
FROM "AccountClassificationLatest" WHERE "value" = true GROUP BY 1, 2;
