#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "[weekly-analyze-supervisor.test] $*" >&2
  exit 1
}

make_case_repo() {
  local case_dir="$1"
  mkdir -p "$case_dir/repo/scripts" "$case_dir/home/.local/share/mise/shims"
  cp "$REPO_ROOT/scripts/weekly-analyze.sh" "$case_dir/repo/scripts/weekly-analyze.sh"
  cp "$REPO_ROOT/scripts/weekly-analyze-runtime.sh" "$case_dir/repo/scripts/weekly-analyze-runtime.sh"
  chmod +x "$case_dir/repo/scripts/weekly-analyze.sh"
}

AUTH_CASE="$TMP_ROOT/auth"
make_case_repo "$AUTH_CASE"
AUTH_SHIMS="$AUTH_CASE/home/.local/share/mise/shims"
cat > "$AUTH_SHIMS/claude" <<'SCRIPT'
#!/bin/sh
printf '%s\n' '{"loggedIn":false}'
SCRIPT
cat > "$AUTH_SHIMS/tmux" <<'SCRIPT'
#!/bin/sh
exit 0
SCRIPT
cat > "$AUTH_SHIMS/pnpm" <<'SCRIPT'
#!/bin/sh
touch "$PNPM_CALLED"
exit 1
SCRIPT
chmod +x "$AUTH_SHIMS/claude" "$AUTH_SHIMS/tmux" "$AUTH_SHIMS/pnpm"
export PNPM_CALLED="$AUTH_CASE/pnpm-called"
set +e
env HOME="$AUTH_CASE/home" PATH=/usr/local/bin:/usr/bin:/bin \
  /bin/sh "$AUTH_CASE/repo/scripts/weekly-analyze.sh"
AUTH_STATUS=$?
set -e
[ "$AUTH_STATUS" -ne 0 ] || fail 'logged-out Claude preflight unexpectedly succeeded'
grep -q 'Claude authentication is not valid' "$AUTH_CASE/repo/logs/weekly-analyze.log" || \
  fail 'logged-out Claude was not rejected by the authentication preflight'
[ ! -e "$PNPM_CALLED" ] || fail 'pnpm ran even though Claude authentication was invalid'

STALE_CASE="$TMP_ROOT/stale"
make_case_repo "$STALE_CASE"
STALE_SHIMS="$STALE_CASE/home/.local/share/mise/shims"
export TIMEOUT_MARKER="$STALE_CASE/timeout-called"
export TMUX_COUNT="$STALE_CASE/tmux-count"
export TMUX_ARGS="$STALE_CASE/tmux-args"
cat > "$STALE_SHIMS/claude" <<'SCRIPT'
#!/bin/sh
if [ "${1:-}" = auth ] && [ "${2:-}" = status ]; then
  printf '%s\n' '{"loggedIn":true}'
  exit 0
fi
exit 0
SCRIPT
cat > "$STALE_SHIMS/pnpm" <<'SCRIPT'
#!/bin/sh
case "$*" in
  'install --frozen-lockfile') exit 0 ;;
  *'weekly-analysis-run.ts create'*) printf '%s\n' '{"id":"run1"}' ;;
  *'weekly-analysis-run.ts list-running'*) printf '%s\n' '[]' ;;
  *'weekly-analysis-run.ts timeout'*) touch "$TIMEOUT_MARKER"; printf '%s\n' '{"ok":true}' ;;
  *'weekly-analysis-run.ts get'*)
    if [ -e "$TIMEOUT_MARKER" ]; then
      printf '%s\n' '{"id":"run1","status":"timeout","staleAfterAt":"2000-01-01T00:00:00Z"}'
    else
      printf '%s\n' '{"id":"run1","status":"running","staleAfterAt":"2000-01-01T00:00:00Z"}'
    fi
    ;;
  *'weekly-analysis-run.ts fail'*) printf '%s\n' '{"ok":true}' ;;
  *) printf '%s\n' '{}' ;;
esac
SCRIPT
cat > "$STALE_SHIMS/git" <<'SCRIPT'
#!/bin/sh
if [ "${1:-}" = worktree ] && [ "${2:-}" = add ]; then
  mkdir -p "$3"
fi
exit 0
SCRIPT
cat > "$STALE_SHIMS/tmux" <<'SCRIPT'
#!/bin/sh
if [ "${1:-}" = new-session ]; then
  printf '%s\n' "$*" > "$TMUX_ARGS"
fi
if [ "${1:-}" = has-session ]; then
  count=0
  [ -f "$TMUX_COUNT" ] && count="$(cat "$TMUX_COUNT")"
  count=$((count + 1))
  printf '%s' "$count" > "$TMUX_COUNT"
  [ "$count" -eq 1 ]
  exit $?
fi
exit 0
SCRIPT
chmod +x "$STALE_SHIMS/claude" "$STALE_SHIMS/pnpm" "$STALE_SHIMS/git" "$STALE_SHIMS/tmux"
set +e
timeout 6s env HOME="$STALE_CASE/home" PATH="$STALE_SHIMS:/usr/local/bin:/usr/bin:/bin" \
  /bin/sh "$STALE_CASE/repo/scripts/weekly-analyze.sh"
STALE_STATUS=$?
set -e
[ "$STALE_STATUS" -eq 0 ] || fail "stale supervisor did not finish cleanly (status=$STALE_STATUS)"
[ -e "$TIMEOUT_MARKER" ] || fail 'stale WeeklyAnalysisRun was not transitioned to timeout'
grep -q 'exceeded staleAfterAt=' "$STALE_CASE/repo/logs/weekly-analyze.log" || \
  fail 'stale timeout was not recorded in the supervisor log'
grep -Fq -- "-e PATH=$STALE_SHIMS:" "$TMUX_ARGS" || \
  fail 'tmux session did not receive the cron-repaired PATH explicitly'

echo '[weekly-analyze-supervisor.test] ok'
