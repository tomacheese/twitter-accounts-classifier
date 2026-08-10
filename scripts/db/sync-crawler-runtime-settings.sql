-- crawler/blocker の切断済みクライアントが長時間クエリを残さないよう、
-- PostgreSQL 自身に実行中接続の生存確認をさせる。statement_timeout は正規の
-- 長時間バッチを壊すため crawler には設定しない。
ALTER ROLE crawler SET client_connection_check_interval = '5s';
