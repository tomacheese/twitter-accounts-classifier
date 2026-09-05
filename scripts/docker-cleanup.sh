#!/bin/sh
set -eu

# Weekly maintenance for unattended operation: weekly-analyze.sh rebuilds the crawler/viewer
# images whenever the review skill commits a fix, and each rebuild leaves the previous
# image layers and build cache behind. Without this, disk usage would grow unbounded over
# months of daily cron runs. PostgreSQL は ./data/postgres の bind mount を使うため、この script は
# Docker image と build cache だけを prune し、DB data は削除しない。
cd "$(dirname "$0")/.."

LOG_FILE="$(pwd)/logs/docker-cleanup.log"
mkdir -p "$(dirname "$LOG_FILE")"
if [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE")" -gt 5242880 ]; then
  mv "$LOG_FILE" "$LOG_FILE.1"
fi
exec >> "$LOG_FILE" 2>&1

DOCKER_BIN="$(command -v docker || true)"
if [ -z "$DOCKER_BIN" ]; then
  echo "[docker-cleanup] docker binary not found on PATH" >&2
  exit 1
fi

echo "[docker-cleanup] starting at $(date -Iseconds)"
"$DOCKER_BIN" image prune -af --filter "until=720h"
"$DOCKER_BIN" builder prune -f --filter "until=720h"
echo "[docker-cleanup] finished at $(date -Iseconds)"

# Suggested crontab entry (edit with `crontab -e` on the host running this repo):
# 0 5 * * 0 PATH=/usr/local/bin:/usr/bin:/bin /path/to/twitter-account-classifier/scripts/docker-cleanup.sh
