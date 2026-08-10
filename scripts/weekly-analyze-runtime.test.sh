#!/bin/sh
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
. "$REPO_ROOT/scripts/weekly-analyze-runtime.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "[weekly-analyze-runtime.test] $*" >&2
  exit 1
}

assert_eq() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

TEST_HOME="$TMP_DIR/home"
mkdir -p "$TEST_HOME/.local/share/mise/shims"
HOME="$TEST_HOME"
PATH=/usr/local/bin:/usr/bin:/bin
weekly_analyze_prepend_mise_shims
assert_eq "${PATH%%:*}" "$TEST_HOME/.local/share/mise/shims"

CLAUDE_BIN="$TMP_DIR/claude"
cat > "$CLAUDE_BIN" <<'SCRIPT'
#!/bin/sh
printf '{"loggedIn":%s}\n' "${CLAUDE_LOGGED_IN:-false}"
SCRIPT
chmod +x "$CLAUDE_BIN"
CLAUDE_LOGGED_IN=true weekly_analyze_check_claude_auth "$CLAUDE_BIN" /usr/bin/jq
if CLAUDE_LOGGED_IN=false weekly_analyze_check_claude_auth "$CLAUDE_BIN" /usr/bin/jq 2>/dev/null; then
  fail 'logged-out Claude session was accepted'
fi

PNPM_BIN="$TMP_DIR/pnpm"
PNPM_CAPTURE="$TMP_DIR/pnpm-capture"
export PNPM_CAPTURE
cat > "$PNPM_BIN" <<'SCRIPT'
#!/bin/sh
printf 'CI=%s\nARGS=%s\nPWD=%s\n' "${CI:-}" "$*" "$PWD" > "$PNPM_CAPTURE"
SCRIPT
chmod +x "$PNPM_BIN"
weekly_analyze_prepare_dependencies "$PNPM_BIN"
grep -qx 'CI=true' "$PNPM_CAPTURE" || fail 'pnpm install did not run with CI=true'
grep -qx 'ARGS=install --frozen-lockfile' "$PNPM_CAPTURE" || fail 'pnpm install arguments are incorrect'
WORKTREE_DIR="$TMP_DIR/worktree"
mkdir -p "$WORKTREE_DIR"
weekly_analyze_prepare_dependencies "$PNPM_BIN" "$WORKTREE_DIR"
grep -qx "PWD=$WORKTREE_DIR" "$PNPM_CAPTURE" || fail 'pnpm install did not run in the requested worktree'

PAST='2026-08-09T00:00:00Z'
FUTURE='2026-08-09T02:00:00Z'
NOW_EPOCH="$(date -d '2026-08-09T01:00:00Z' +%s)"
weekly_analyze_stale_after_passed "$PAST" "$NOW_EPOCH" || fail 'past stale deadline was not detected'
if weekly_analyze_stale_after_passed "$FUTURE" "$NOW_EPOCH"; then
  fail 'future stale deadline was treated as stale'
fi
if weekly_analyze_stale_after_passed '' "$NOW_EPOCH"; then
  fail 'empty stale deadline was treated as stale'
fi
if weekly_analyze_stale_after_passed 'not-a-date' "$NOW_EPOCH"; then
  fail 'invalid stale deadline was treated as stale'
fi




URL_WITHOUT_QUERY="$(weekly_analyze_database_url_with_application_name \
  'postgresql://weekly_review:test@example.invalid/testdb' 'weekly-crawl-review-run1')"
assert_eq "$URL_WITHOUT_QUERY" \
  'postgresql://weekly_review:test@example.invalid/testdb?application_name=weekly-crawl-review-run1'
URL_WITH_QUERY="$(weekly_analyze_database_url_with_application_name \
  'postgresql://weekly_review:test@example.invalid/testdb?connect_timeout=5' 'weekly-crawl-review-run1')"
assert_eq "$URL_WITH_QUERY" \
  'postgresql://weekly_review:test@example.invalid/testdb?connect_timeout=5&application_name=weekly-crawl-review-run1'

echo '[weekly-analyze-runtime.test] ok'
