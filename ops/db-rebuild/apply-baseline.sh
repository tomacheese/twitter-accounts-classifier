#!/bin/bash
# 新 DB に baseline (baseline.sql、Tweet の方式別 SQL、functions.sql) を適用する。
# 使い方: ops/db-rebuild/apply-baseline.sh <hash|range> [--reset]
#   --reset: public、mig、stg スキーマを落としてから適用する (リハーサルのやり直し用。新 DB 専用で、本番の DB には使わない)
#   ENUM_UPDATED=1: AccountLabelChangeType に 'updated' を足す (旧データの changeType='updated' を残すリハーサル用の上書き)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

VARIANT="${1:-}"
case "$VARIANT" in hash | range) ;; *) die "usage: $0 <hash|range> [--reset]" ;; esac
BASELINE_DIR="$HERE/../../prisma/baseline"

if [ "${2:-}" = --reset ]; then
    new_psql -q -c "SET client_min_messages = warning" -c "DROP SCHEMA IF EXISTS mig, stg, public CASCADE" -c "CREATE SCHEMA public" >/dev/null
fi

{
    cat "$BASELINE_DIR/baseline.sql" "$BASELINE_DIR/tweet-$VARIANT.sql" "$BASELINE_DIR/functions.sql"
} | new_psql -q -1 >/dev/null

# ALTER TYPE ... ADD VALUE は、追加した値を同じトランザクション内では使えないため、単独の文で実行する。
if [ "${ENUM_UPDATED:-0}" = 1 ]; then
    new_psql -q -c "ALTER TYPE \"AccountLabelChangeType\" ADD VALUE IF NOT EXISTS 'updated'" >/dev/null
fi
log "baseline ($VARIANT) applied"
