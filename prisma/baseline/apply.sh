#!/bin/bash
# baseline を空の DB へ適用する。適用済みの DB (Account テーブルがある) では何もしない。
# 新 DB はこの baseline から作るため、prisma migrate deploy は実行しない。
# 使い方: DATABASE_URL=<所有者の接続先> prisma/baseline/apply.sh
# 本番で使うのは TWEET_VARIANT=hash (既定) だけで、range は採用しない。
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"
DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VARIANT="${TWEET_VARIANT:-hash}"

if [ ! -f "$DIR/tweet-$VARIANT.sql" ]; then
  echo "unknown TWEET_VARIANT: $VARIANT" >&2
  exit 1
fi

applied="$(psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "SELECT to_regclass('public.\"Account\"') IS NOT NULL")"
if [ "$applied" = "t" ]; then
  echo "baseline already applied; skipping"
  exit 0
fi

# functions.sql は、その時点で存在するアプリ用ロールの権限だけを整える。
# 適用後に scripts/db/sync-crawler-grants.sql などの権限同期を必ず流す。
psql -X -q -v ON_ERROR_STOP=1 -1 "$DATABASE_URL" \
  -f "$DIR/baseline.sql" -f "$DIR/tweet-$VARIANT.sql" -f "$DIR/functions.sql" >/dev/null
echo "baseline applied (tweet variant: $VARIANT)"
