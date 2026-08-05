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

PNPM_BIN="$(command -v pnpm || true)"
if [ -z "$PNPM_BIN" ]; then
  echo "[weekly-analysis-heartbeat] pnpm binary not found on PATH" >&2
  exit 1
fi

"$PNPM_BIN" --filter crawler exec tsx scripts/weekly-analysis-run.ts heartbeat \
  --id "$WEEKLY_ANALYSIS_RUN_ID" --phase "$PHASE"
