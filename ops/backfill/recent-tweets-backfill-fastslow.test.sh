#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="$REPO_ROOT/ops/backfill/recent-tweets-backfill-fastslow.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "[recent-tweets-backfill-fastslow.test] $*" >&2
  exit 1
}

CASE_REPO="$TMP_DIR/repo"
FAKE_BIN="$TMP_DIR/bin"
DOCKER_LOG="$TMP_DIR/docker.log"
mkdir -p "$CASE_REPO/data" "$FAKE_BIN"
cat > "$CASE_REPO/data/config.json" <<'JSON'
{"accounts":[{"username":"a"},{"username":"b"},{"username":"c"},{"username":"d"},{"username":"e"}]}
JSON

cat > "$FAKE_BIN/docker" <<'SCRIPT'
#!/bin/bash
set -u
printf '%s\n' "$*" >> "$DOCKER_LOG"
case " $* " in
  *' exec -T postgres '*)
    printf '1\n'
    ;;
  *' exec -T crawler sh -lc '*)
    ;;
  *recent-tweets-backfill-ops.js*)
    if [[ " $* " == *' --execute '* ]]; then
      printf '%s\n' "Error: Cannot find module '/app/crawler/dist/scripts/recent-tweets-backfill-ops.js'" >&2
      exit 1
    fi
    printf '%s\n' '{"accountIds":["1"],"nextAfterId":null}'
    ;;
  *)
    printf '%s\n' '{"accountIds":[]}'
    ;;
esac
SCRIPT
chmod +x "$FAKE_BIN/docker"

set +e
timeout 10s env \
  PATH="$FAKE_BIN:/usr/local/bin:/usr/bin:/bin" \
  DOCKER_LOG="$DOCKER_LOG" \
  BACKFILL_COMPOSE_DIR="$CASE_REPO" \
  BACKFILL_FAST_WORKERS=1 \
  BACKFILL_FAST_MIN_START_INTERVAL=0 \
  BACKFILL_SLOW_MIN_START_INTERVAL=0 \
  BACKFILL_ERROR_RETRY_DELAY=0 \
  "$RUNNER" >"$TMP_DIR/runner.out" 2>"$TMP_DIR/runner.err"
RUNNER_STATUS=$?
set -e

if [ "$RUNNER_STATUS" -ne 75 ]; then
  cat "$TMP_DIR/runner.out" "$TMP_DIR/runner.err" >&2
  cat "$DOCKER_LOG" >&2
  fail "missing helper did not yield to supervisor (status=$RUNNER_STATUS)"
fi
grep -q '^RUNTIME_FAULT ' "$TMP_DIR/runner.out" || fail 'runtime fault was not reported'
grep -q 'exec -T postgres ' "$DOCKER_LOG" || fail 'in-flight work was not checked before exit cleanup'

SELF_TEST_OUTPUT="$("$RUNNER" --self-test 2>&1)" || fail 'self-test requires the production compose directory'
grep -qx 'FASTSLOW_SELF_TEST_OK fast_chunks=2 slow_chunks=3 total=52 unique=52' <<<"$SELF_TEST_OUTPUT" || \
  fail 'self-test did not report the expected queue invariants'

echo '[recent-tweets-backfill-fastslow.test] ok'
