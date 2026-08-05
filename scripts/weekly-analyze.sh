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

JQ_BIN="$(command -v jq || true)"
if [ -z "$JQ_BIN" ]; then
  echo "[weekly-analyze] jq binary not found on PATH" >&2
  exit 1
fi

# WeeklyAnalysisRun の ID から各種名前を決定的に導出することで、新旧のスーパーバイザーが
# 同時に走っても衝突しない (固定名前提だった従来のセッション・worktree 管理を置き換える)。
echo "[weekly-analyze] creating WeeklyAnalysisRun record"
RUN_JSON="$(pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts create)"
RUN_ID="$(printf '%s' "$RUN_JSON" | "$JQ_BIN" -r '.id')"
if [ -z "$RUN_ID" ] || [ "$RUN_ID" = "null" ]; then
  echo "[weekly-analyze] failed to create WeeklyAnalysisRun" >&2
  exit 1
fi
export WEEKLY_ANALYSIS_RUN_ID="$RUN_ID"

SESSION_NAME="weekly-crawl-review-$RUN_ID"
WORKTREE_DIR="$(pwd)/.worktrees/weekly-crawl-review-$RUN_ID"
WORKTREE_BRANCH="weekly-crawl-review-$RUN_ID"
DIAGNOSTICS_DIR="$(pwd)/logs/weekly-analysis-runs/$RUN_ID"

# 前回実行が running のまま残っている場合、その PR の状態を確認してから今回の実行に進む。
echo "[weekly-analyze] checking for still-running previous WeeklyAnalysisRun records"
PREVIOUS_RUNS_JSON="$(pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts list-running)"
PREVIOUS_RUN_IDS="$(printf '%s' "$PREVIOUS_RUNS_JSON" | "$JQ_BIN" -r ".[] | select(.id != \"$RUN_ID\") | .id")"

for PREVIOUS_RUN_ID in $PREVIOUS_RUN_IDS; do
  PREVIOUS_RUN_JSON="$(pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts get --id "$PREVIOUS_RUN_ID")"
  PREVIOUS_PR_NUMBER="$(printf '%s' "$PREVIOUS_RUN_JSON" | "$JQ_BIN" -r '.pullRequestNumber // empty')"

  if [ -z "$PREVIOUS_PR_NUMBER" ]; then
    echo "[weekly-analyze] previous run $PREVIOUS_RUN_ID has no recorded PR; leaving it for a future check"
    continue
  fi

  PREVIOUS_STATUS_JSON="$(pnpm --filter crawler exec tsx scripts/weekly-analysis-github.ts status --pr "$PREVIOUS_PR_NUMBER")"
  PREVIOUS_PR_STATUS="$(printf '%s' "$PREVIOUS_STATUS_JSON" | "$JQ_BIN" -r '.status // empty')"

  case "$PREVIOUS_PR_STATUS" in
    merged)
      echo "[weekly-analyze] previous run $PREVIOUS_RUN_ID's PR #$PREVIOUS_PR_NUMBER is merged; recording success retroactively"
      pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts complete \
        --id "$PREVIOUS_RUN_ID" --pull-request-number "$PREVIOUS_PR_NUMBER"
      ;;
    ready)
      echo "[weekly-analyze] previous run $PREVIOUS_RUN_ID's PR #$PREVIOUS_PR_NUMBER is auto-mergeable; waiting up to 10 minutes"
      WAIT_DEADLINE=$(($(date +%s) + 600))
      while [ "$(date +%s)" -lt "$WAIT_DEADLINE" ]; do
        RECHECK_JSON="$(pnpm --filter crawler exec tsx scripts/weekly-analysis-github.ts status --pr "$PREVIOUS_PR_NUMBER")"
        RECHECK_STATUS="$(printf '%s' "$RECHECK_JSON" | "$JQ_BIN" -r '.status // empty')"
        if [ "$RECHECK_STATUS" = "merged" ]; then
          echo "[weekly-analyze] previous run $PREVIOUS_RUN_ID's PR #$PREVIOUS_PR_NUMBER merged while waiting"
          pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts complete \
            --id "$PREVIOUS_RUN_ID" --pull-request-number "$PREVIOUS_PR_NUMBER"
          break
        fi
        sleep 30
      done
      if [ "$RECHECK_STATUS" != "merged" ]; then
        echo "[weekly-analyze] previous run $PREVIOUS_RUN_ID's PR #$PREVIOUS_PR_NUMBER still not merged after 10 minutes; leaving it untouched for the next check"
      fi
      ;;
    *)
      echo "[weekly-analyze] previous run $PREVIOUS_RUN_ID's PR #$PREVIOUS_PR_NUMBER is not mergeable ($PREVIOUS_PR_STATUS); closing it and marking the run failed"
      pnpm --filter crawler exec tsx scripts/weekly-analysis-github.ts disable-auto-merge --pr "$PREVIOUS_PR_NUMBER"
      pnpm --filter crawler exec tsx scripts/weekly-analysis-github.ts close --pr "$PREVIOUS_PR_NUMBER" \
        --message "この PR は後続の週次分析実行に置き換えられたため閉じます。"
      pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts fail \
        --id "$PREVIOUS_RUN_ID" --message "後続の週次分析実行に置き換えられました。"
      ;;
  esac
done

# Run the review in an isolated worktree rather than this checkout: this checkout may be
# `master`, which a developer or another automated flow can have dirty/in-progress at any
# time, and the skill itself now works on its own feature branch anyway (see
# .claude/skills/weekly-crawl-review/SKILL.md step 8).
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

mkdir -p "$DIAGNOSTICS_DIR"
PANE_LOG="$DIAGNOSTICS_DIR/pane-output.log"

echo "[weekly-analyze] starting weekly crawl review at $(date -Iseconds) in tmux session $SESSION_NAME"
"$TMUX_BIN" new-session -d -s "$SESSION_NAME" -c "$WORKTREE_DIR" -e "WEEKLY_ANALYSIS_RUN_ID=$RUN_ID" \
  "$CLAUDE_BIN" --permission-mode auto "Use the weekly-crawl-review skill to review this week's labeling output and make any needed fixes."
"$TMUX_BIN" pipe-pane -t "$SESSION_NAME" -o "cat >> \"$PANE_LOG\""
echo "[weekly-analyze] launched tmux session $SESSION_NAME at $(date -Iseconds)"

# スキルは直接コミットしてローカルで再ビルドする代わりに GitHub auto-merge 付きの PR を
# 開くようになった。本番機は CI 通過・auto-merge 後に GHCR から自分でイメージを取得するため、
# tmux セッションの生存確認だけでなく DB ステータスも見ることで、セッションは残っていても
# 状態機械側が終端状態に達した場合を検知できるようにする。
while true; do
  if ! "$TMUX_BIN" has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "[weekly-analyze] tmux session $SESSION_NAME finished at $(date -Iseconds)"
    break
  fi
  CURRENT_RUN_JSON="$(pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts get --id "$RUN_ID")"
  CURRENT_STATUS="$(printf '%s' "$CURRENT_RUN_JSON" | "$JQ_BIN" -r '.status // empty')"
  if [ "$CURRENT_STATUS" != "running" ]; then
    echo "[weekly-analyze] WeeklyAnalysisRun $RUN_ID reached terminal status $CURRENT_STATUS at $(date -Iseconds)"
    break
  fi
  sleep 30
done

# 成功・失敗いずれの終了でも診断情報を残す。worktree の状態は失敗調査に必要だが、
# 成功時まで残すと使い捨てのはずの worktree が無期限に積み上がってしまう。
FINAL_RUN_JSON="$(pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts get --id "$RUN_ID")"
FINAL_STATUS="$(printf '%s' "$FINAL_RUN_JSON" | "$JQ_BIN" -r '.status // empty')"

echo "[weekly-analyze] saving diagnostics for run $RUN_ID (status=$FINAL_STATUS) to $DIAGNOSTICS_DIR"
{
  cd "$WORKTREE_DIR"
  git status --porcelain
  echo '--- diff ---'
  git diff
  echo '--- untracked ---'
  git ls-files --others --exclude-standard
} > "$DIAGNOSTICS_DIR/git-state.log" 2>&1 || true
printf '%s\n' "$FINAL_RUN_JSON" > "$DIAGNOSTICS_DIR/run-metadata.json"
# シークレット (.env・.env.weekly-review) 由来の値が紛れ込まないよう、
# 保存前にそれらのファイル自体を診断ディレクトリにコピーしない。

if [ "$FINAL_STATUS" = "success" ]; then
  echo "[weekly-analyze] run succeeded; removing worktree at $WORKTREE_DIR"
  git worktree remove --force "$WORKTREE_DIR" 2>/dev/null || rm -rf "$WORKTREE_DIR"
  git worktree prune
  git branch -D "$WORKTREE_BRANCH" 2>/dev/null || true
else
  echo "[weekly-analyze] run ended with status $FINAL_STATUS; keeping worktree at $WORKTREE_DIR for inspection"
fi

# 単純な mtime ベースの find だと成功・失敗を区別できないため、各実行ディレクトリの
# run-metadata.json に保存した status を読んで保持期間 (成功 30 日・失敗 90 日) を判定する。
echo "[weekly-analyze] pruning diagnostics older than retention window"
NOW_EPOCH="$(date +%s)"
for DIR in "$(pwd)"/logs/weekly-analysis-runs/*/; do
  [ -d "$DIR" ] || continue
  METADATA_FILE="$DIR/run-metadata.json"
  [ -f "$METADATA_FILE" ] || continue
  DIR_STATUS="$("$JQ_BIN" -r '.status // empty' < "$METADATA_FILE")"
  DIR_MTIME_EPOCH="$(date -r "$METADATA_FILE" +%s 2>/dev/null || echo "$NOW_EPOCH")"
  AGE_DAYS=$(((NOW_EPOCH - DIR_MTIME_EPOCH) / 86400))
  if [ "$DIR_STATUS" = "success" ] && [ "$AGE_DAYS" -gt 30 ]; then
    rm -rf "$DIR"
  elif [ "$DIR_STATUS" != "success" ] && [ "$AGE_DAYS" -gt 90 ]; then
    rm -rf "$DIR"
  fi
done

# Suggested crontab entry (edit with `crontab -e` on the host running this repo):
# 0 6 * * * PATH=/path/to/claude-bin:/usr/local/bin:/usr/bin:/bin /path/to/twitter-accounts-classifier/scripts/weekly-analyze.sh
