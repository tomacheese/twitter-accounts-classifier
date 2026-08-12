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
  mkdir -p "$case_dir/repo/scripts" "$case_dir/repo/crawler/node_modules/.bin" "$case_dir/home/.local/share/mise/shims"
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
export TMUX_DATABASE_URL="$STALE_CASE/tmux-database-url"
export REVIEW_PLAN_CALLED="$STALE_CASE/review-plan-called"
cat > "$STALE_CASE/repo/.env.weekly-review" <<'ENV'
DATABASE_URL=postgresql://weekly_review:test-password@192.0.2.10:5432/testdb
ENV
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
  *) printf '%s\n' 'pnpm wrapper must not be used for weekly-analysis JSON commands' >&2; exit 99 ;;
esac
SCRIPT
cat > "$STALE_CASE/repo/crawler/node_modules/.bin/tsx" <<'SCRIPT'
#!/bin/sh
case "$*" in
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
  *'weekly-analysis-run.ts cancel-backends'*) printf '%s\n' '{"cancelled":0}' ;;
  *'weekly-review-plan.ts build'*)
    touch "$REVIEW_PLAN_CALLED"
    output=''
    previous=''
    for argument in "$@"; do
      if [ "$previous" = '--output' ]; then output="$argument"; break; fi
      previous="$argument"
    done
    [ -n "$output" ] || exit 98
    mkdir -p "$(dirname "$output")"
    printf '%s\n' '{"schemaVersion":1,"strategyVersion":"risk-stratified/1","samples":[]}' > "$output"
    printf '%s\n' '{"sampleCount":0}'
    ;;
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
  printf '%s\n' "${DATABASE_URL:-}" > "$TMUX_DATABASE_URL"
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
chmod +x "$STALE_SHIMS/claude" "$STALE_SHIMS/pnpm" "$STALE_SHIMS/git" "$STALE_SHIMS/tmux" "$STALE_CASE/repo/crawler/node_modules/.bin/tsx"
set +e
timeout 6s env HOME="$STALE_CASE/home" PATH="$STALE_SHIMS:/usr/local/bin:/usr/bin:/bin" \
  /bin/sh "$STALE_CASE/repo/scripts/weekly-analyze.sh"
STALE_STATUS=$?
set -e
[ "$STALE_STATUS" -eq 0 ] || fail "stale supervisor did not finish cleanly (status=$STALE_STATUS)"
[ -e "$TIMEOUT_MARKER" ] || fail 'stale WeeklyAnalysisRun was not transitioned to timeout'
[ -e "$REVIEW_PLAN_CALLED" ] || fail 'review plan was not generated before launching Claude'
grep -q 'exceeded staleAfterAt=' "$STALE_CASE/repo/logs/weekly-analyze.log" || \
  fail 'stale timeout was not recorded in the supervisor log'
grep -Fq -- "-e PATH=$STALE_SHIMS:" "$TMUX_ARGS" || \
  fail 'tmux session did not receive the cron-repaired PATH explicitly'
grep -Fq -- '-e DATABASE_URL -e WEEKLY_ANALYSIS_RUN_ID=run1' "$TMUX_ARGS" || \
  fail 'tmux session did not inherit the weekly-review DATABASE_URL by variable name'
grep -Fq -- '-e WEEKLY_REVIEW_PLAN_FILE=' "$TMUX_ARGS" || \
  fail 'tmux session did not receive the review plan file path'
grep -Fq -- '-e WEEKLY_REVIEW_RESULT_FILE=' "$TMUX_ARGS" || \
  fail 'tmux session did not receive the canonical review result file path'
grep -Fq -- '--agent weekly-review-coordinator' "$TMUX_ARGS" || \
  fail 'weekly review did not launch with the coordinator agent'
grep -Fq -- '-e PGAPPNAME=weekly-crawl-review-run1' "$TMUX_ARGS" || \
  fail 'tmux session did not receive the run-scoped PostgreSQL application_name'
grep -qx 'postgresql://weekly_review:test-password@192.0.2.10:5432/testdb?application_name=weekly-crawl-review-run1' "$TMUX_DATABASE_URL" || \
  fail 'tmux session did not inherit a run-scoped application_name in DATABASE_URL'
if grep -Fq -- 'DATABASE_URL=postgresql://' "$TMUX_ARGS"; then
  fail 'tmux invocation exposed the weekly-review DATABASE_URL value in process arguments'
fi


TRAP_CASE="$TMP_ROOT/trap"
make_case_repo "$TRAP_CASE"
cat > "$TRAP_CASE/repo/.env.weekly-review" <<'ENV'
DATABASE_URL=postgresql://weekly_review:test-password@192.0.2.10:5432/testdb
ENV
TRAP_SHIMS="$TRAP_CASE/home/.local/share/mise/shims"
export TRAP_CLEANUP_MARKER="$TRAP_CASE/cleanup-called"
export TRAP_FAIL_MARKER="$TRAP_CASE/fail-called"
cat > "$TRAP_SHIMS/claude" <<'SCRIPT'
#!/bin/sh
if [ "${1:-}" = auth ] && [ "${2:-}" = status ]; then
  printf '%s\n' '{"loggedIn":true}'
fi
SCRIPT
cat > "$TRAP_SHIMS/pnpm" <<'SCRIPT'
#!/bin/sh
[ "$*" = 'install --frozen-lockfile' ] && exit 0
exit 99
SCRIPT
cat > "$TRAP_CASE/repo/crawler/node_modules/.bin/tsx" <<'SCRIPT'
#!/bin/sh
case "$*" in
  *'weekly-analysis-run.ts create'*) printf '%s\n' '{"id":"run1"}' ;;
  *'weekly-analysis-run.ts list-running'*) printf '%s\n' '[]' ;;
  *'weekly-analysis-run.ts get'*) printf '%s\n' '{"id":"run1","status":"running"}' ;;
  *'weekly-analysis-run.ts fail'*) touch "$TRAP_FAIL_MARKER"; printf '%s\n' '{"ok":true}' ;;
  *'weekly-analysis-run.ts cancel-backends'*) touch "$TRAP_CLEANUP_MARKER"; printf '%s\n' '{"cancelled":0}' ;;
  *) printf '%s\n' '{}' ;;
esac
SCRIPT
cat > "$TRAP_SHIMS/git" <<'SCRIPT'
#!/bin/sh
if [ "${1:-}" = worktree ] && [ "${2:-}" = add ]; then
  exit 42
fi
exit 0
SCRIPT
cat > "$TRAP_SHIMS/tmux" <<'SCRIPT'
#!/bin/sh
exit 0
SCRIPT
chmod +x "$TRAP_SHIMS/claude" "$TRAP_SHIMS/pnpm" "$TRAP_SHIMS/git" "$TRAP_SHIMS/tmux" \
  "$TRAP_CASE/repo/crawler/node_modules/.bin/tsx"
set +e
env HOME="$TRAP_CASE/home" PATH="$TRAP_SHIMS:/usr/local/bin:/usr/bin:/bin" \
  /bin/sh "$TRAP_CASE/repo/scripts/weekly-analyze.sh"
TRAP_STATUS=$?
set -e
[ "$TRAP_STATUS" -ne 0 ] || fail 'unexpected-exit case unexpectedly succeeded'
[ -e "$TRAP_FAIL_MARKER" ] || fail 'unexpected-exit trap did not mark WeeklyAnalysisRun failed'
[ -e "$TRAP_CLEANUP_MARKER" ] || fail 'unexpected-exit trap did not cancel residual PostgreSQL backends'

SUCCESS_CASE="$TMP_ROOT/success"
make_case_repo "$SUCCESS_CASE"
cat > "$SUCCESS_CASE/repo/.env.weekly-review" <<'ENV'
DATABASE_URL=postgresql://weekly_review:test-password@192.0.2.10:5432/testdb
ENV
SUCCESS_SHIMS="$SUCCESS_CASE/home/.local/share/mise/shims"
export SUCCESS_TMUX_EVENTS="$SUCCESS_CASE/tmux-events"
export SUCCESS_TMUX_KILLED="$SUCCESS_CASE/tmux-killed"
cat > "$SUCCESS_SHIMS/claude" <<'SCRIPT'
#!/bin/sh
if [ "${1:-}" = auth ] && [ "${2:-}" = status ]; then
  printf '%s\n' '{"loggedIn":true}'
fi
SCRIPT
cat > "$SUCCESS_SHIMS/pnpm" <<'SCRIPT'
#!/bin/sh
[ "$*" = 'install --frozen-lockfile' ] && exit 0
exit 99
SCRIPT
cat > "$SUCCESS_CASE/repo/crawler/node_modules/.bin/tsx" <<'SCRIPT'
#!/bin/sh
case "$*" in
  *'weekly-analysis-run.ts create'*) printf '%s\n' '{"id":"run1"}' ;;
  *'weekly-analysis-run.ts list-running'*) printf '%s\n' '[]' ;;
  *'weekly-analysis-run.ts get'*) printf '%s\n' '{"id":"run1","status":"success"}' ;;
  *'weekly-analysis-run.ts cancel-backends'*) printf '%s\n' '{"cancelled":0}' ;;
  *'weekly-review-plan.ts build'*)
    output=''
    previous=''
    for argument in "$@"; do
      if [ "$previous" = '--output' ]; then output="$argument"; break; fi
      previous="$argument"
    done
    [ -n "$output" ] || exit 98
    mkdir -p "$(dirname "$output")"
    printf '%s\n' '{"schemaVersion":1,"strategyVersion":"risk-stratified/1","samples":[]}' > "$output"
    printf '%s\n' '{"sampleCount":0}'
    ;;
  *) printf '%s\n' '{}' ;;
esac
SCRIPT
cat > "$SUCCESS_SHIMS/tmux" <<'SCRIPT'
#!/bin/sh
case "${1:-}" in
  has-session)
    [ ! -e "$SUCCESS_TMUX_KILLED" ]
    exit $?
    ;;
  display-message)
    printf '%s\n' '999999'
    ;;
  pipe-pane)
    case " $* " in
      *' -o '*) ;;
      *) printf '%s\n' 'pipe-disabled' >> "$SUCCESS_TMUX_EVENTS" ;;
    esac
    ;;
  kill-session)
    printf '%s\n' 'kill-session' >> "$SUCCESS_TMUX_EVENTS"
    touch "$SUCCESS_TMUX_KILLED"
    ;;
esac
exit 0
SCRIPT
chmod +x "$SUCCESS_SHIMS/claude" "$SUCCESS_SHIMS/pnpm" "$SUCCESS_SHIMS/tmux" \
  "$SUCCESS_CASE/repo/crawler/node_modules/.bin/tsx"
(
  cd "$SUCCESS_CASE/repo"
  git init -q -b master
  git config user.name test
  git config user.email test@example.invalid
  mkdir -p "$SUCCESS_CASE/hooks"
  git config core.hooksPath "$SUCCESS_CASE/hooks"
  git add scripts
  git commit -q -m init
)
set +e
timeout 6s env WEEKLY_REVIEW_TMUX_GRACE_SECONDS=0 WEEKLY_REVIEW_PROCESS_GRACE_SECONDS=0 \
  HOME="$SUCCESS_CASE/home" PATH="$SUCCESS_SHIMS:/usr/local/bin:/usr/bin:/bin" \
  /bin/sh "$SUCCESS_CASE/repo/scripts/weekly-analyze.sh"
SUCCESS_STATUS=$?
set -e
[ "$SUCCESS_STATUS" -eq 0 ] || fail "successful supervisor cleanup failed (status=$SUCCESS_STATUS)"
grep -q 'pruning diagnostics older than retention window' "$SUCCESS_CASE/repo/logs/weekly-analyze.log" || \
  fail 'successful supervisor did not reach diagnostics cleanup after removing its worktree'
[ -e "$SUCCESS_TMUX_KILLED" ] || fail 'successful supervisor did not forcibly terminate lingering tmux session'
EXPECTED_TMUX_EVENTS='pipe-disabled
kill-session'
ACTUAL_TMUX_EVENTS="$(cat "$SUCCESS_TMUX_EVENTS" 2>/dev/null || true)"
[ "$ACTUAL_TMUX_EVENTS" = "$EXPECTED_TMUX_EVENTS" ] || \
  fail "tmux forced-cleanup order was unexpected: $ACTUAL_TMUX_EVENTS"

echo '[weekly-analyze-supervisor.test] ok'
