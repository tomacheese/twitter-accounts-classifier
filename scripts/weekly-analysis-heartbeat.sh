#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

PHASE="${1:-}"
if [ -z "$PHASE" ]; then
  echo "[weekly-analysis-heartbeat] usage: weekly-analysis-heartbeat.sh <phase>" >&2
  exit 1
fi

if [ -z "${WEEKLY_ANALYSIS_RUN_ID:-}" ]; then
  echo "[weekly-analysis-heartbeat] WEEKLY_ANALYSIS_RUN_ID environment variable is required" >&2
  exit 1
fi

TSX_BIN="$(pwd)/crawler/node_modules/.bin/tsx"
RUN_CLI="$(pwd)/crawler/scripts/weekly-analysis-run.ts"
if [ ! -x "$TSX_BIN" ]; then
  echo "[weekly-analysis-heartbeat] tsx binary not found: $TSX_BIN" >&2
  exit 1
fi

set +e
"$TSX_BIN" "$RUN_CLI" heartbeat \
  --id "$WEEKLY_ANALYSIS_RUN_ID" --phase "$PHASE"
STATUS=$?
set -e
if [ "$STATUS" -ne 0 ]; then
  echo "[weekly-analysis-heartbeat] heartbeat CLI exited non-zero (status=$STATUS)" >&2
fi
exit "$STATUS"
