#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

PR_NUMBER="${1:-}"
if [ -z "$PR_NUMBER" ]; then
  echo "[weekly-analysis-wait-pr] usage: weekly-analysis-wait-pr.sh <pr-number>" >&2
  exit 7
fi

if [ -z "${WEEKLY_ANALYSIS_RUN_ID:-}" ]; then
  echo "[weekly-analysis-wait-pr] WEEKLY_ANALYSIS_RUN_ID environment variable is required" >&2
  exit 7
fi

for bin in pnpm jq; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "[weekly-analysis-wait-pr] $bin binary not found on PATH" >&2
    exit 7
  fi
done

CI_TIMEOUT_SECONDS="${WEEKLY_ANALYSIS_CI_TIMEOUT_SECONDS:-7200}"
POLL_INTERVAL_SECONDS=30
START_EPOCH="$(date +%s)"

while true; do
  NOW_EPOCH="$(date +%s)"
  ELAPSED=$((NOW_EPOCH - START_EPOCH))
  if [ "$ELAPSED" -ge "$CI_TIMEOUT_SECONDS" ]; then
    echo "[weekly-analysis-wait-pr] timed out after ${ELAPSED}s waiting on PR #$PR_NUMBER" >&2
    exit 3
  fi

  RUN_JSON="$(pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts get --id "$WEEKLY_ANALYSIS_RUN_ID")"
  RUN_STATUS="$(printf '%s' "$RUN_JSON" | jq -r '.status // empty')"
  if [ "$RUN_STATUS" != "running" ]; then
    echo "[weekly-analysis-wait-pr] WeeklyAnalysisRun $WEEKLY_ANALYSIS_RUN_ID is no longer running (status=$RUN_STATUS)" >&2
    exit 6
  fi

  if ! scripts/weekly-analysis-heartbeat.sh waiting_ci; then
    echo "[weekly-analysis-wait-pr] heartbeat call failed" >&2
    exit 7
  fi

  if ! STATUS_JSON="$(pnpm --filter crawler exec tsx scripts/weekly-analysis-github.ts status --pr "$PR_NUMBER")"; then
    echo "[weekly-analysis-wait-pr] failed to fetch PR #$PR_NUMBER status" >&2
    exit 7
  fi
  PR_STATUS="$(printf '%s' "$STATUS_JSON" | jq -r '.status // empty')"

  case "$PR_STATUS" in
    merged|ready)
      echo "[weekly-analysis-wait-pr] PR #$PR_NUMBER is ready ($PR_STATUS)"
      exit 0
      ;;
    review_required)
      echo "[weekly-analysis-wait-pr] PR #$PR_NUMBER needs review" >&2
      exit 1
      ;;
    failed_checks)
      echo "[weekly-analysis-wait-pr] PR #$PR_NUMBER has failing required checks" >&2
      exit 2
      ;;
    merge_blocked)
      echo "[weekly-analysis-wait-pr] PR #$PR_NUMBER is merge-blocked" >&2
      exit 4
      ;;
    auto_merge_disabled)
      echo "[weekly-analysis-wait-pr] PR #$PR_NUMBER has auto-merge disabled" >&2
      exit 5
      ;;
    closed)
      echo "[weekly-analysis-wait-pr] PR #$PR_NUMBER was closed without merging" >&2
      exit 8
      ;;
    waiting_checks|mergeability_unknown)
      sleep "$POLL_INTERVAL_SECONDS"
      ;;
    *)
      echo "[weekly-analysis-wait-pr] unexpected PR status: $PR_STATUS" >&2
      exit 7
      ;;
  esac
done
