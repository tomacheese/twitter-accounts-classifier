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

# 固定名前提だった従来の管理方式では新旧のスーパーバイザーが同時に走ると衝突するため、
# WeeklyAnalysisRun の ID から各種名前を決定的に導出する。
echo "[weekly-analyze] creating WeeklyAnalysisRun record"
RUN_JSON="$(pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts create)"
RUN_ID="$(printf '%s' "$RUN_JSON" | "$JQ_BIN" -r '.id')"
if [ -z "$RUN_ID" ] || [ "$RUN_ID" = "null" ]; then
  echo "[weekly-analyze] failed to create WeeklyAnalysisRun" >&2
  exit 1
fi
export WEEKLY_ANALYSIS_RUN_ID="$RUN_ID"

# スーパーバイザー自身が予期せず異常終了した場合でも WeeklyAnalysisRun を running のまま
# 放置しないよう、終了時に status を確認しまだ running であれば失敗として終端させる。
finalize_run_on_unexpected_exit() {
  EXIT_CODE=$?
  RUN_STATUS_JSON="$(pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts get --id "$RUN_ID" 2>/dev/null || true)"
  RUN_STATUS="$(printf '%s' "$RUN_STATUS_JSON" | "$JQ_BIN" -r '.status // empty' 2>/dev/null || true)"
  if [ "$RUN_STATUS" = "running" ]; then
    echo "[weekly-analyze] supervisor exiting unexpectedly (exit code $EXIT_CODE) while WeeklyAnalysisRun $RUN_ID was still running; marking it failed" >&2
    pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts fail \
      --id "$RUN_ID" --message "weekly-analyze.sh supervisor exited unexpectedly (exit code $EXIT_CODE)." >/dev/null 2>&1 || true
  fi
  exit "$EXIT_CODE"
}
trap finalize_run_on_unexpected_exit EXIT

SESSION_NAME="weekly-crawl-review-$RUN_ID"
WORKTREE_DIR="$(pwd)/.worktrees/weekly-crawl-review-$RUN_ID"
WORKTREE_BRANCH="weekly-crawl-review-$RUN_ID"
DIAGNOSTICS_DIR="$(pwd)/logs/weekly-analysis-runs/$RUN_ID"

echo "[weekly-analyze] checking for still-running previous WeeklyAnalysisRun records"
PREVIOUS_RUNS_JSON="$(pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts list-running)"
PREVIOUS_RUN_IDS="$(printf '%s' "$PREVIOUS_RUNS_JSON" | "$JQ_BIN" -r ".[] | select(.id != \"$RUN_ID\") | .id")"

for PREVIOUS_RUN_ID in $PREVIOUS_RUN_IDS; do
  PREVIOUS_RUN_JSON="$(pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts get --id "$PREVIOUS_RUN_ID")"
  PREVIOUS_PR_NUMBER="$(printf '%s' "$PREVIOUS_RUN_JSON" | "$JQ_BIN" -r '.pullRequestNumber // empty')"
  PREVIOUS_PR_URL="$(printf '%s' "$PREVIOUS_RUN_JSON" | "$JQ_BIN" -r '.pullRequestUrl // empty')"

  if [ -z "$PREVIOUS_PR_NUMBER" ]; then
    PREVIOUS_STALE_AFTER="$(printf '%s' "$PREVIOUS_RUN_JSON" | "$JQ_BIN" -r '.staleAfterAt // empty')"
    PREVIOUS_STALE_AFTER_EPOCH=0
    [ -n "$PREVIOUS_STALE_AFTER" ] && PREVIOUS_STALE_AFTER_EPOCH="$(date -d "$PREVIOUS_STALE_AFTER" +%s 2>/dev/null || echo 0)"
    if [ "$PREVIOUS_STALE_AFTER_EPOCH" -gt 0 ] && [ "$(date +%s)" -gt "$PREVIOUS_STALE_AFTER_EPOCH" ]; then
      echo "[weekly-analyze] previous run $PREVIOUS_RUN_ID has no recorded PR and is past its stale deadline; marking it timed out"
      TIMEOUT_JSON="$(pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts timeout \
        --id "$PREVIOUS_RUN_ID" --message "この実行は PR を作成しないままハートビートの停止放置判定を超えました。" || true)"
      if [ "$(printf '%s' "$TIMEOUT_JSON" | "$JQ_BIN" -r '.ok // empty')" != "true" ]; then
        echo "[weekly-analyze] timeout call for previous run $PREVIOUS_RUN_ID did not apply (already terminal?)" >&2
      fi
    else
      echo "[weekly-analyze] previous run $PREVIOUS_RUN_ID has no recorded PR yet and is not past its stale deadline; leaving it for a future check"
    fi
    continue
  fi

  PREVIOUS_STATUS_JSON="$(pnpm --filter crawler exec tsx scripts/weekly-analysis-github.ts status --pr "$PREVIOUS_PR_NUMBER")"
  PREVIOUS_PR_STATUS="$(printf '%s' "$PREVIOUS_STATUS_JSON" | "$JQ_BIN" -r '.status // empty')"

  case "$PREVIOUS_PR_STATUS" in
    merged)
      echo "[weekly-analyze] previous run $PREVIOUS_RUN_ID's PR #$PREVIOUS_PR_NUMBER is merged; recording success retroactively"
      COMPLETE_JSON="$(pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts complete \
        --id "$PREVIOUS_RUN_ID" --pull-request-number "$PREVIOUS_PR_NUMBER" --pull-request-url "$PREVIOUS_PR_URL")"
      if [ "$(printf '%s' "$COMPLETE_JSON" | "$JQ_BIN" -r '.ok')" != "true" ]; then
        echo "[weekly-analyze] complete call for previous run $PREVIOUS_RUN_ID did not apply (already terminal?)" >&2
      fi
      ;;
    ready)
      echo "[weekly-analyze] previous run $PREVIOUS_RUN_ID's PR #$PREVIOUS_PR_NUMBER is auto-mergeable; waiting up to 10 minutes"
      WAIT_DEADLINE=$(($(date +%s) + 600))
      while [ "$(date +%s)" -lt "$WAIT_DEADLINE" ]; do
        RECHECK_JSON="$(pnpm --filter crawler exec tsx scripts/weekly-analysis-github.ts status --pr "$PREVIOUS_PR_NUMBER")"
        RECHECK_STATUS="$(printf '%s' "$RECHECK_JSON" | "$JQ_BIN" -r '.status // empty')"
        if [ "$RECHECK_STATUS" = "merged" ]; then
          echo "[weekly-analyze] previous run $PREVIOUS_RUN_ID's PR #$PREVIOUS_PR_NUMBER merged while waiting"
          COMPLETE_JSON="$(pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts complete \
            --id "$PREVIOUS_RUN_ID" --pull-request-number "$PREVIOUS_PR_NUMBER")"
          if [ "$(printf '%s' "$COMPLETE_JSON" | "$JQ_BIN" -r '.ok')" != "true" ]; then
            echo "[weekly-analyze] complete call for previous run $PREVIOUS_RUN_ID did not apply (already terminal?)" >&2
          fi
          break
        fi
        sleep 30
      done
      if [ "$RECHECK_STATUS" != "merged" ]; then
        echo "[weekly-analyze] previous run $PREVIOUS_RUN_ID's PR #$PREVIOUS_PR_NUMBER still not merged after 10 minutes; leaving it untouched for the next check"
      fi
      ;;
    review_required)
      echo "[weekly-analyze] previous run $PREVIOUS_RUN_ID's PR #$PREVIOUS_PR_NUMBER needs review; leaving it untouched for the next cron cycle"
      continue
      ;;
    auto_merge_disabled)
      echo "[weekly-analyze] previous run $PREVIOUS_RUN_ID's PR #$PREVIOUS_PR_NUMBER has auto-merge disabled; closing it and marking the run failed"
      pnpm --filter crawler exec tsx scripts/weekly-analysis-github.ts close --pr "$PREVIOUS_PR_NUMBER" \
        --message "この PR は後続の週次分析実行に置き換えられたため閉じます。" || true
      FAIL_JSON="$(pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts fail \
        --id "$PREVIOUS_RUN_ID" --message "後続の週次分析実行に置き換えられました。" || true)"
      if [ "$(printf '%s' "$FAIL_JSON" | "$JQ_BIN" -r '.ok // empty')" != "true" ]; then
        echo "[weekly-analyze] fail call for previous run $PREVIOUS_RUN_ID did not apply (already terminal?)" >&2
      fi
      ;;
    closed)
      echo "[weekly-analyze] previous run $PREVIOUS_RUN_ID's PR #$PREVIOUS_PR_NUMBER is already closed; marking the run failed"
      FAIL_JSON="$(pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts fail \
        --id "$PREVIOUS_RUN_ID" --message "後続の週次分析実行に置き換えられました。" || true)"
      if [ "$(printf '%s' "$FAIL_JSON" | "$JQ_BIN" -r '.ok // empty')" != "true" ]; then
        echo "[weekly-analyze] fail call for previous run $PREVIOUS_RUN_ID did not apply (already terminal?)" >&2
      fi
      ;;
    *)
      echo "[weekly-analyze] previous run $PREVIOUS_RUN_ID's PR #$PREVIOUS_PR_NUMBER is not mergeable ($PREVIOUS_PR_STATUS); closing it and marking the run failed"
      pnpm --filter crawler exec tsx scripts/weekly-analysis-github.ts disable-auto-merge --pr "$PREVIOUS_PR_NUMBER" || true
      pnpm --filter crawler exec tsx scripts/weekly-analysis-github.ts close --pr "$PREVIOUS_PR_NUMBER" \
        --message "この PR は後続の週次分析実行に置き換えられたため閉じます。" || true
      FAIL_JSON="$(pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts fail \
        --id "$PREVIOUS_RUN_ID" --message "後続の週次分析実行に置き換えられました。" || true)"
      if [ "$(printf '%s' "$FAIL_JSON" | "$JQ_BIN" -r '.ok // empty')" != "true" ]; then
        echo "[weekly-analyze] fail call for previous run $PREVIOUS_RUN_ID did not apply (already terminal?)" >&2
      fi
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

# PR の auto-merge は tmux セッションの終了と同期しないため、
# セッションの生存確認だけでなく DB 上のステータスも見て終端を判定する。
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

# tmux セッションの終了は PR の auto-merge やレビュー対応の完了と同期しないため、
# セッションが消えた時点でまだ running のままなら異常終了とみなし失敗として終端させる。
if [ "$FINAL_STATUS" = "running" ]; then
  echo "[weekly-analyze] tmux session ended while WeeklyAnalysisRun $RUN_ID was still running; marking it failed"
  pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts fail \
    --id "$RUN_ID" --message "tmux セッションが終端状態に到達する前に消滅しました。" || true
  FINAL_RUN_JSON="$(pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts get --id "$RUN_ID")"
  FINAL_STATUS="$(printf '%s' "$FINAL_RUN_JSON" | "$JQ_BIN" -r '.status // empty')"
fi

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
  git branch -D "$WORKTREE_BRANCH" 2>/dev/null || true
else
  echo "[weekly-analyze] run ended with status $FINAL_STATUS; keeping worktree at $WORKTREE_DIR for inspection"
fi

# 失敗した worktree は調査用に残すが、無期限に積み上げないよう直近1件だけを残す。
# 今回の実行が成功していても、それより前の失敗実行の worktree が残っている場合があるため、
# 成功・失敗いずれの分岐でも実行する。
echo "[weekly-analyze] pruning older failed worktrees, keeping only the most recent one"
for OLD_WORKTREE in "$(pwd)"/.worktrees/weekly-crawl-review-*/; do
  [ -d "$OLD_WORKTREE" ] || continue
  OLD_WORKTREE="${OLD_WORKTREE%/}"
  [ "$OLD_WORKTREE" = "$WORKTREE_DIR" ] && continue
  echo "[weekly-analyze] removing older failed worktree at $OLD_WORKTREE"
  git worktree remove --force "$OLD_WORKTREE" 2>/dev/null || rm -rf "$OLD_WORKTREE"
done
git worktree prune

# mtime だけでは成功・失敗を区別できないため、run-metadata.json に保存した status を読んで
# 保持期間を判定する。
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
