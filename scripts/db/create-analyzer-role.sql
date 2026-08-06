-- analyzer が接続するためのロールを初回作成する。
-- 既に analyzer が存在する環境では、このファイルではなく
-- sync-analyzer-grants.sql だけを実行する。
--
-- 実行前に CHANGE_ME_ANALYZER_PASSWORD を強いパスワードへ置き換え、
-- 同じ値を analyzer の DATABASE_URL に設定する。秘密値はcommitしない。
-- Prisma migrationを実行するテーブル所有者ロールで実行すること。

CREATE ROLE analyzer
  WITH LOGIN PASSWORD 'CHANGE_ME_ANALYZER_PASSWORD';

-- 正本テーブルへはSELECTのみ、分析・運用・読み取りモデルテーブルへは
-- INSERT/UPDATE/DELETEを許可するallowlist方式で権限を同期する。
-- \ir はこのファイルの所在を基準に相対パスを解決する。
\ir sync-analyzer-grants.sql
