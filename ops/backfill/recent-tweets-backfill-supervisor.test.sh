#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPERVISOR="$REPO_ROOT/ops/backfill/recent-tweets-backfill-supervisor.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "[recent-tweets-backfill-supervisor.test] $*" >&2
  exit 1
}

FAKE_BIN="$TMP_DIR/bin"
OPS_SOURCE="$REPO_ROOT/ops/backfill/recent-tweets-backfill-ops.js"
RUNNER="$TMP_DIR/runner.sh"
STATE_FILE="$TMP_DIR/state"
DOCKER_LOG="$TMP_DIR/docker.log"
mkdir -p "$FAKE_BIN" "$TMP_DIR/compose"
[ -f "$OPS_SOURCE" ] || fail 'tracked runtime helper is missing'

cat > "$RUNNER" <<'SCRIPT'
#!/bin/bash
if [ ! -f "$RUNNER_RESTARTED" ]; then
  touch "$RUNNER_RESTARTED"
  exit 75
fi
exit 0
SCRIPT
cat > "$FAKE_BIN/docker" <<'SCRIPT'
#!/bin/bash
set -u
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  'compose ps -q crawler') printf '%s\n' synthetic-crawler ;;
  cp*) touch "$STATE_FILE" ;;
  'compose exec -T crawler node --check '*) ;;
  'compose exec -T crawler sha256sum '*)
    if [ -f "$STATE_FILE" ]; then
      sha256sum "$OPS_SOURCE"
    else
      printf '%s\n' 'stale helper'
    fi
    ;;
  *) exit 99 ;;
esac
SCRIPT
chmod +x "$RUNNER" "$FAKE_BIN/docker"

env \
  PATH="$FAKE_BIN:/usr/local/bin:/usr/bin:/bin" \
  DOCKER_LOG="$DOCKER_LOG" \
  OPS_SOURCE="$OPS_SOURCE" \
  STATE_FILE="$STATE_FILE" \
  RUNNER_RESTARTED="$TMP_DIR/restarted" \
  BACKFILL_COMPOSE_DIR="$TMP_DIR/compose" \
  BACKFILL_RUNNER="$RUNNER" \
  BACKFILL_RESTART_DELAY=0 \
  "$SUPERVISOR" >"$TMP_DIR/supervisor.out"

grep -qx 'SUPERVISOR_RUNTIME_REPAIRED' "$TMP_DIR/supervisor.out" || \
  fail 'supervisor did not repair the missing helper before retrying'
grep -qx 'SUPERVISOR_RESTART rc=75 delay_s=0' "$TMP_DIR/supervisor.out" || \
  fail 'supervisor did not restart after the runner yielded a runtime fault'
grep -qx 'SUPERVISOR_COMPLETE' "$TMP_DIR/supervisor.out" || fail 'supervisor did not complete after restart'
[ "$(grep -c '^compose ps -q crawler$' "$DOCKER_LOG")" -eq 2 ] || \
  fail 'supervisor did not re-check runtime before restarting the runner'

echo '[recent-tweets-backfill-supervisor.test] ok'
