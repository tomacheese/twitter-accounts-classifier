#!/bin/bash
set -euo pipefail

# migration実行後、全ロールの権限同期と検証をまとめて行う。
# 検証が失敗した場合はデプロイを止めるため、非ゼロ終了する。
#
# create-*-role.sql はロールを初回作成する一度限りの手順であり、
# 二回目以降の実行では CREATE ROLE が既存ロールと衝突してデプロイを止めてしまう。
# そのためここでは含めず、運用者が初回セットアップ時に手動で実行する前提とする。
# sync-*-grants.sql・verify-*-grants.sql は毎回の実行が冪等なため、
# migration のたびに自動実行してよい。

psql "$DATABASE_URL" -f scripts/db/sync-viewer-grants.sql
psql "$DATABASE_URL" -f scripts/db/sync-analyzer-grants.sql
psql "$DATABASE_URL" -f scripts/db/sync-weekly-review-grants.sql

psql "$DATABASE_URL" -f scripts/db/verify-viewer-grants.sql
psql "$DATABASE_URL" -f scripts/db/verify-analyzer-grants.sql
psql "$DATABASE_URL" -f scripts/db/verify-weekly-review-grants.sql

echo "grant sync and verification succeeded"
