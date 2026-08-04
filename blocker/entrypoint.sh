#!/bin/sh
set -eu

# `docker compose run blocker <command>` が <command> を $@ として渡すため、これを尊重しないと
# 一回限りの実行 (例: 手動デバッグ) がコンテナ内で常にブロックサイクルの無限ループへ
# フォールスルーしてしまう。
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

INTERVAL_SECONDS="${BLOCK_INTERVAL_SECONDS:-21600}"

cd /app/blocker

while true; do
  echo "[entrypoint] starting block cycle at $(date -Iseconds)"
  if ! node dist/index.js; then
    echo "[entrypoint] block cycle exited with an error, will retry after the interval" >&2
  fi
  echo "[entrypoint] sleeping for ${INTERVAL_SECONDS}s"
  sleep "${INTERVAL_SECONDS}"
done
