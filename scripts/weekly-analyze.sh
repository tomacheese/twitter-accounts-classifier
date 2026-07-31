#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

# The crontab entry no longer redirects output itself, so this script owns rotation:
# without it, cron running daily would grow this file unbounded over months.
LOG_FILE="$(pwd)/logs/weekly-analyze.log"
mkdir -p "$(dirname "$LOG_FILE")"
if [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE")" -gt 5242880 ]; then
  mv "$LOG_FILE" "$LOG_FILE.1"
fi
exec >> "$LOG_FILE" 2>&1

# cron runs jobs with a minimal environment (no shell profile, no DATABASE_URL),
# so load the repo's .env explicitly before the skill runs any prisma command.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# The dev machine's normal DATABASE_URL points at its local Postgres; weekly-crawl-review
# needs to read/write the production Postgres instead, via the least-privilege
# weekly_review role. .env.weekly-review overrides DATABASE_URL for this run only.
if [ -f .env.weekly-review ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.weekly-review
  set +a
fi

CLAUDE_BIN="$(command -v claude || true)"
if [ -z "$CLAUDE_BIN" ]; then
  echo "[weekly-analyze] claude binary not found on PATH" >&2
  exit 1
fi

TMUX_BIN="$(command -v tmux || true)"
if [ -z "$TMUX_BIN" ]; then
  echo "[weekly-analyze] tmux binary not found on PATH" >&2
  exit 1
fi

SESSION_NAME="weekly-crawl-review"

# Fixed session name so a still-running previous invocation (e.g. from running this
# daily rather than weekly) is killed and replaced instead of piling up alongside it.
if "$TMUX_BIN" has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "[weekly-analyze] killing still-running previous session $SESSION_NAME"
  "$TMUX_BIN" kill-session -t "$SESSION_NAME"
fi

# Run the review in an isolated worktree rather than this checkout: this checkout may be
# `master`, which a developer or another automated flow can have dirty/in-progress at any
# time, and the skill itself now works on its own feature branch anyway (see
# .claude/skills/weekly-crawl-review/SKILL.md step 8). Fixed path/branch name, same
# reasoning as SESSION_NAME above: a stale worktree from a killed/crashed previous run is
# removed and recreated from the current master rather than left to pile up or go stale.
WORKTREE_DIR="$(pwd)/.worktrees/weekly-crawl-review"
WORKTREE_BRANCH="weekly-crawl-review-$(date +%Y%m%d-%H%M%S)"

if git worktree list --porcelain | grep -qx "worktree $WORKTREE_DIR"; then
  echo "[weekly-analyze] removing stale worktree at $WORKTREE_DIR"
  git worktree remove --force "$WORKTREE_DIR" 2>/dev/null || rm -rf "$WORKTREE_DIR"
  git worktree prune
fi

echo "[weekly-analyze] creating isolated worktree at $WORKTREE_DIR"
git worktree add "$WORKTREE_DIR" -b "$WORKTREE_BRANCH" master

# .env / .env.weekly-review are gitignored, so the new worktree doesn't get them via
# git — copy the ones already loaded into this shell's environment above instead. The
# skill only needs these to be readable from its own working directory (crawler commands
# run with `--filter crawler` from the repo root either way).
[ -f .env ] && cp .env "$WORKTREE_DIR/.env"
[ -f .env.weekly-review ] && cp .env.weekly-review "$WORKTREE_DIR/.env.weekly-review"

echo "[weekly-analyze] starting weekly crawl review at $(date -Iseconds) in tmux session $SESSION_NAME"
"$TMUX_BIN" new-session -d -s "$SESSION_NAME" -c "$WORKTREE_DIR" \
  "$CLAUDE_BIN" --permission-mode auto "Use the weekly-crawl-review skill to review this week's labeling output and make any needed fixes."
echo "[weekly-analyze] launched tmux session $SESSION_NAME at $(date -Iseconds)"

# The skill now opens a PR with GitHub auto-merge instead of committing directly and
# rebuilding locally (see .claude/skills/weekly-crawl-review/SKILL.md) — the production
# machine pulls its own images from GHCR once CI passes and the PR auto-merges, so this
# script's job ends once the review session finishes.
while "$TMUX_BIN" has-session -t "$SESSION_NAME" 2>/dev/null; do
  sleep 30
done
echo "[weekly-analyze] tmux session $SESSION_NAME finished at $(date -Iseconds)"

# The worktree's only purpose was to isolate the review session's work from this
# checkout; once the skill has pushed its branch and opened a PR, GitHub owns the rest
# (CI + auto-merge), so nothing further needs to survive locally. Remove the worktree and
# the throwaway branch used to create it — this does NOT remove whatever feature branch
# the skill itself created and pushed inside the worktree (see WORKTREE_BRANCH above),
# since that branch's local ref, if left behind, is harmless and can be pruned manually.
echo "[weekly-analyze] cleaning up worktree at $WORKTREE_DIR"
git worktree remove --force "$WORKTREE_DIR" 2>/dev/null || rm -rf "$WORKTREE_DIR"
git worktree prune
git branch -D "$WORKTREE_BRANCH" 2>/dev/null || true

# Suggested crontab entry (edit with `crontab -e` on the host running this repo):
# 0 6 * * * PATH=/path/to/claude-bin:/usr/local/bin:/usr/bin:/bin /path/to/twitter-accounts-classifier/scripts/weekly-analyze.sh
