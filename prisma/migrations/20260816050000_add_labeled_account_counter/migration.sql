-- CreateTable
CREATE TABLE "LabeledAccountCounter" (
    "id" TEXT NOT NULL,
    "labeledAccounts" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LabeledAccountCounter_pkey" PRIMARY KEY ("id")
);

-- AccountSummaryLatest.activeLabelCount が 0 ⇔ 正 を跨いだ行だけ、LabeledAccountCounter を ±1 する。
-- アプリケーション層の read-modify-write は並行 upsert 時に stale な値を減算しうるため、
-- account_classification_latest_aggregate_trigger と同様にトリガーへ寄せる。
CREATE OR REPLACE FUNCTION account_summary_latest_labeled_counter_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_was_labeled BOOLEAN;
  v_is_labeled BOOLEAN;
BEGIN
  v_was_labeled := (TG_OP <> 'INSERT') AND (OLD."activeLabelCount" > 0);
  v_is_labeled := (TG_OP <> 'DELETE') AND (NEW."activeLabelCount" > 0);

  IF v_was_labeled = v_is_labeled THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  UPDATE "LabeledAccountCounter"
    SET "labeledAccounts" = "labeledAccounts" + (CASE WHEN v_is_labeled THEN 1 ELSE -1 END),
        "updatedAt" = now()
    WHERE "id" = 'global';

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER account_summary_latest_labeled_counter_trigger
  AFTER INSERT OR UPDATE OR DELETE ON "AccountSummaryLatest"
  FOR EACH ROW EXECUTE FUNCTION account_summary_latest_labeled_counter_trigger();

-- backfill。CREATE TRIGGER (上記) の取得するロックにより、
-- migration トランザクションがコミットするまで AccountSummaryLatest への書き込みはブロックされる。
-- そのため、backfill が読む「トリガー作成前の状態」とそれ以降の書き込みの間に隙間はできない。
-- COUNT(*) は GROUP BY なしの集約のため、対象行が0件でも必ず1行(値0)を返す。
INSERT INTO "LabeledAccountCounter" ("id", "labeledAccounts", "updatedAt")
SELECT 'global', COUNT(*), now()
FROM "AccountSummaryLatest"
WHERE "activeLabelCount" > 0;
