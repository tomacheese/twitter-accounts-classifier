-- 新 DB (baseline 適用済み) に、移行用のスキーマ (mig、stg) と進捗表を作る。load.sh が最初に一度だけ実行する。
-- mig: 進捗、変換表、投入前に退避した制約・インデックスの定義。stg: 変換の途中経過を置く作業用の表。
-- どちらも切り替え前に cleanup.sql で落とす。baseline.sql の対象ではない。
-- 冪等: 既にある場合は何もしない (再実行で進捗を消さない)。

CREATE SCHEMA IF NOT EXISTS mig;
CREATE SCHEMA IF NOT EXISTS stg;

CREATE TABLE IF NOT EXISTS mig.progress (
  step        text PRIMARY KEY,
  rows        bigint NOT NULL,
  seconds     numeric NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mig.meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);

-- 旧 LabelDefinition.id (cuid) から新 smallint id への変換表。transform/00_label_map.sql の出力。
CREATE TABLE IF NOT EXISTS mig.label_map (
  old_id               text PRIMARY KEY,
  new_id               smallint NOT NULL UNIQUE,
  key                  text NOT NULL,
  description          text NOT NULL,
  created_at           text,
  current_rule_version text,
  placeholder          boolean NOT NULL
);

-- 旧 work item / AnalysisRun の text id から新 int id への変換表。finalize/21_work.sql が作る。
CREATE TABLE IF NOT EXISTS mig.map_work_item (old_id text PRIMARY KEY, new_id integer NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS mig.map_run (old_id text PRIMARY KEY, new_id integer NOT NULL UNIQUE);

-- シャード実行 (リハーサル) で対象にしたアカウント。全量実行では空。
CREATE TABLE IF NOT EXISTS mig.shard_account (id bigint PRIMARY KEY);

-- 投入前に外した制約とインデックスの定義。投入後に load.sh restore が作り直す。
CREATE TABLE IF NOT EXISTS mig.index_def (
  table_name text NOT NULL,
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('index', 'constraint')),
  def        text NOT NULL,
  ord        integer NOT NULL,
  restored   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (table_name, name)
);
CREATE TABLE IF NOT EXISTS mig.fk_def (
  table_name text NOT NULL,
  name       text NOT NULL,
  def        text NOT NULL,
  restored   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (table_name, name)
);

-- Tweet の子パーティション。投入前に切り離して作り直す。bound は pg_get_expr の結果 (FOR VALUES ...)。
CREATE TABLE IF NOT EXISTS mig.tweet_part (
  part_no    integer PRIMARY KEY,
  leaf       text NOT NULL UNIQUE,
  bound      text NOT NULL,
  reloptions text,
  attached   boolean NOT NULL DEFAULT false
);

-- stg: finalize が参照する作業用の表。
CREATE TABLE IF NOT EXISTS stg.label_row (
  "accountId"      bigint NOT NULL,
  "lid"            smallint NOT NULL,
  "value"          boolean NOT NULL,
  "evaluable"      boolean NOT NULL,
  "labeledAt"      timestamptz NOT NULL,
  "confidence"     double precision,
  "ruleVersion"    text NOT NULL,
  "sourceKind"     smallint,
  "method"         text,
  "reason"         text,
  "sourceId"       text,
  "sourceUsername" text
);
CREATE TABLE IF NOT EXISTS stg.work_item_ref ("id" text NOT NULL);

DO $$
DECLARE
  r record;
BEGIN
  -- id などの text 化が必要な列だけを上書きした、新テーブルと同じ形の作業用テーブル。
  FOR r IN SELECT * FROM (VALUES
    ('AnalysisWorkItem', ARRAY['id']),
    ('AnalysisWorkItemDone', ARRAY['workItemId']),
    ('AnalysisRun', ARRAY['id', 'workItemId']),
    ('LabelMetricSnapshot', ARRAY['triggerWorkItemId', 'analysisRunId']),
    ('OverviewSnapshot', ARRAY['analysisRunId']),
    ('ReadModelGeneration', ARRAY['analysisRunId']),
    ('OperationStage', ARRAY['analysisRunId'])
  ) AS v(tbl, text_cols)
  LOOP
    IF to_regclass(format('stg.%I', r.tbl)) IS NULL THEN
      EXECUTE format('CREATE TABLE stg.%I (LIKE public.%I INCLUDING DEFAULTS)', r.tbl, r.tbl);
      EXECUTE (
        SELECT format('ALTER TABLE stg.%I ', r.tbl)
          || string_agg(format('ALTER COLUMN %I DROP DEFAULT, ALTER COLUMN %I TYPE text', c, c), ', ')
        FROM unnest(r.text_cols) AS c
      );
    END IF;
  END LOOP;
END
$$;
