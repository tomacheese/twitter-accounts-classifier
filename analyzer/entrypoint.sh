#!/bin/sh
set -eu

# `docker compose run analyzer <command>` が <command> を $@ として渡すため、これを尊重しないと
# 一回限りの実行 (例: 手動デバッグ) がコンテナ内で常にポーリングの無限ループへ
# フォールスルーしてしまう。
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# crawler/blocker の周期 (数時間単位) と異なり、analyzer は queue に溜まった
# WorkItem をできるだけ低遅延で捌く必要があるため、既定の待機時間を短くする。
INTERVAL_SECONDS="${ANALYZER_POLL_INTERVAL_SECONDS:-10}"

cd /app/analyzer

while true; do
  if ! node dist/index.js; then
    echo "[entrypoint] worker pass exited with an error, will retry after the interval" >&2
  fi
  sleep "${INTERVAL_SECONDS}"
done
