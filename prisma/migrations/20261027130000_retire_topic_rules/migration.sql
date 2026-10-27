BEGIN;
SET LOCAL lock_timeout = '3s';

-- topic_* ラベルの行は、巨大なテーブルを 1 transaction で削除するとタイムアウトや長時間ロックを招くため、
-- この migration では消さず、運用スクリプト (crawler/scripts/retire-topic-rules-purge.ts) が batch で削除する。

-- follow-graph signal は topic ルールだけが利用しており、読み手の撤去に合わせて収集とテーブルも廃止する。
DROP TABLE IF EXISTS "LabelingFollowSample";

COMMIT;
