#!/bin/bash
set -u
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RUNNER=${BACKFILL_RUNNER:-"$SCRIPT_DIR/recent-tweets-backfill-fastslow.sh"}
RESTART_DELAY=${BACKFILL_RESTART_DELAY:-30}
COMPOSE_DIR=${BACKFILL_COMPOSE_DIR:-/mnt/hdd/nuts/twitter-accounts-classifier}
OPS_SOURCE=${BACKFILL_OPS_SOURCE:-"$SCRIPT_DIR/recent-tweets-backfill-ops.js"}
OPS_TARGET=/app/crawler/dist/scripts/recent-tweets-backfill-ops.js
trap 'exit 130' INT TERM

ensure_runtime() {
  local expected actual container
  [ -f "$OPS_SOURCE" ] || { echo "SUPERVISOR_RUNTIME_SOURCE_MISSING"; return 1; }
  expected=$(sha256sum "$OPS_SOURCE" | awk '{print $1}')
  cd "$COMPOSE_DIR" || return 1
  container=$(docker compose ps -q crawler 2>/dev/null)
  [ -n "$container" ] || { echo "SUPERVISOR_CRAWLER_UNAVAILABLE"; return 1; }
  actual=$(docker compose exec -T crawler sha256sum "$OPS_TARGET" 2>/dev/null | awk '{print $1}' || true)
  if [ "$actual" != "$expected" ]; then
    docker cp "$OPS_SOURCE" "$container:$OPS_TARGET" >/dev/null || return 1
    docker compose exec -T crawler node --check "$OPS_TARGET" >/dev/null || return 1
    actual=$(docker compose exec -T crawler sha256sum "$OPS_TARGET" 2>/dev/null | awk '{print $1}' || true)
    [ "$actual" = "$expected" ] || return 1
    echo "SUPERVISOR_RUNTIME_REPAIRED"
  fi
  return 0
}
while true; do
  if ! ensure_runtime; then
    echo "SUPERVISOR_RUNTIME_RETRY delay_s=$RESTART_DELAY"
    sleep "$RESTART_DELAY"
    continue
  fi
  bash "$RUNNER"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "SUPERVISOR_COMPLETE"
    exit 0
  fi
  if [ "$rc" -eq 130 ] || [ "$rc" -eq 143 ]; then
    echo "SUPERVISOR_STOP rc=$rc"
    exit "$rc"
  fi
  echo "SUPERVISOR_RESTART rc=$rc delay_s=$RESTART_DELAY"
  sleep "$RESTART_DELAY"
done
