#!/bin/sh

weekly_analyze_prepend_mise_shims() {
  if [ -n "${HOME:-}" ] && [ -d "$HOME/.local/share/mise/shims" ]; then
    PATH="$HOME/.local/share/mise/shims:$PATH"
    export PATH
  fi
}

weekly_analyze_find_command() {
  _weekly_analyze_command="$1"
  _weekly_analyze_path="$(command -v "$_weekly_analyze_command" 2>/dev/null || true)"
  if [ -z "$_weekly_analyze_path" ]; then
    echo "[weekly-analyze] $_weekly_analyze_command binary not found on PATH" >&2
    return 1
  fi
  printf '%s\n' "$_weekly_analyze_path"
}

weekly_analyze_check_claude_auth() {
  _weekly_analyze_claude_bin="$1"
  _weekly_analyze_jq_bin="$2"
  _weekly_analyze_auth_json="$("$_weekly_analyze_claude_bin" auth status 2>/dev/null || true)"
  if ! printf '%s' "$_weekly_analyze_auth_json" | "$_weekly_analyze_jq_bin" -e '.loggedIn == true' >/dev/null 2>&1; then
    echo "[weekly-analyze] Claude authentication is not valid; run 'claude auth login' interactively before the next scheduled run" >&2
    return 1
  fi
}

weekly_analyze_prepare_dependencies() {
  _weekly_analyze_pnpm_bin="$1"
  _weekly_analyze_workdir="${2:-}"
  if [ -n "$_weekly_analyze_workdir" ]; then
    (
      cd "$_weekly_analyze_workdir" || exit 1
      CI=true "$_weekly_analyze_pnpm_bin" install --frozen-lockfile
    )
    return
  fi
  CI=true "$_weekly_analyze_pnpm_bin" install --frozen-lockfile
}

weekly_analyze_stale_after_passed() {
  _weekly_analyze_stale_after="$1"
  _weekly_analyze_now_epoch="${2:-$(date +%s)}"
  [ -n "$_weekly_analyze_stale_after" ] || return 1
  _weekly_analyze_stale_epoch="$(date -d "$_weekly_analyze_stale_after" +%s 2>/dev/null || true)"
  [ -n "$_weekly_analyze_stale_epoch" ] || return 1
  [ "$_weekly_analyze_now_epoch" -gt "$_weekly_analyze_stale_epoch" ]
}

weekly_analyze_terminate_process_group() {
  _weekly_analyze_pid="$1"
  _weekly_analyze_expected_cwd="$2"
  _weekly_analyze_grace_seconds="${3:-5}"

  case "$_weekly_analyze_pid" in
    ''|*[!0-9]*) return 0 ;;
  esac
  /bin/kill -0 "$_weekly_analyze_pid" 2>/dev/null || return 0

  _weekly_analyze_pgid="$(ps -o pgid= -p "$_weekly_analyze_pid" 2>/dev/null | tr -d '[:space:]')"
  if [ "$_weekly_analyze_pgid" != "$_weekly_analyze_pid" ]; then
    echo "[weekly-analyze] refusing to terminate pane pid $_weekly_analyze_pid because it is not its process-group leader" >&2
    return 1
  fi

  _weekly_analyze_actual_cwd="$(readlink "/proc/$_weekly_analyze_pid/cwd" 2>/dev/null || true)"
  case "$_weekly_analyze_actual_cwd" in
    "$_weekly_analyze_expected_cwd"|"$_weekly_analyze_expected_cwd"/*) ;;
    *)
      echo "[weekly-analyze] refusing to terminate pane pid $_weekly_analyze_pid because cwd is outside the run worktree" >&2
      return 1
      ;;
  esac

  /bin/kill -TERM -- "-$_weekly_analyze_pgid" 2>/dev/null || true
  _weekly_analyze_deadline=$(($(date +%s) + _weekly_analyze_grace_seconds))
  while /bin/kill -0 -- "-$_weekly_analyze_pgid" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$_weekly_analyze_deadline" ]; then
      /bin/kill -KILL -- "-$_weekly_analyze_pgid" 2>/dev/null || true
      break
    fi
    sleep 1
  done
}


weekly_analyze_database_url_with_application_name() {
  _weekly_analyze_database_url="$1"
  _weekly_analyze_application_name="$2"
  [ -n "$_weekly_analyze_database_url" ] || return 1
  [ -n "$_weekly_analyze_application_name" ] || {
    printf '%s\n' "$_weekly_analyze_database_url"
    return 0
  }

  case "$_weekly_analyze_database_url" in
    *\?*) _weekly_analyze_separator='&' ;;
    *) _weekly_analyze_separator='?' ;;
  esac
  printf '%s%sapplication_name=%s\n' \
    "$_weekly_analyze_database_url" "$_weekly_analyze_separator" "$_weekly_analyze_application_name"
}
