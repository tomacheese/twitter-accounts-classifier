-- Viewer が接続するための読み取り専用ロールを初回作成する。
-- 既に viewer が存在する環境では、このファイルではなく
-- sync-viewer-grants.sql だけを実行する。
--
-- 実行前に CHANGE_ME_VIEWER_PASSWORD を強いパスワードへ置き換え、
-- 同じ値を Viewer の DATABASE_URL に設定する。秘密値はcommitしない。
-- Prisma migrationを実行するテーブル所有者ロールで実行すること。

CREATE ROLE viewer
  WITH LOGIN PASSWORD 'CHANGE_ME_VIEWER_PASSWORD';

-- 現在の全テーブルへSELECT権限を付与する。write権限は一切付与しない。
-- \ir はこのファイルの所在を基準に相対パスを解決する。
\ir sync-viewer-grants.sql
