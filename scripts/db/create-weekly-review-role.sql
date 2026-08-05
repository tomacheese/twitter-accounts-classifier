-- weekly-crawl-review が開発機から接続するためのロールを初回作成する。
-- 既に weekly_review が存在する環境では、このファイルではなく
-- sync-weekly-review-grants.sql だけを実行する。
--
-- 実行前に CHANGE_ME_WEEKLY_REVIEW_PASSWORD を強いパスワードへ置き換え、
-- 同じ値を開発機の .env.weekly-review に設定する。秘密値はcommitしない。
-- Prisma migrationを実行するテーブル所有者ロールで実行すること。

CREATE ROLE weekly_review
  WITH LOGIN PASSWORD 'CHANGE_ME_WEEKLY_REVIEW_PASSWORD';

-- 現在の全テーブルへread権限を付与し、write権限をallowlistへ限定する。
-- \ir はこのファイルの所在を基準に相対パスを解決する。
\ir sync-weekly-review-grants.sql

-- pg_hba.conf 側で weekly_review ロールの開発機IPからの接続を許可し、
-- crawlerロールはDocker内部ネットワークからのみ許可すること。
-- pg_hba.confの編集は本番機側の運用作業であり、このSQLの対象外。
