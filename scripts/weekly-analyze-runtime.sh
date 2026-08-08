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
