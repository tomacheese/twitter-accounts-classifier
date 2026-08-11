#!/bin/sh
set -eu

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

INTERVAL_SECONDS="${RELABELER_INTERVAL_SECONDS:-30}"

cd /app/crawler

while true; do
  echo "[relabeler-entrypoint] starting relabel-worker cycle at $(date -Iseconds)"
  if ! node dist/relabel-worker.js; then
    echo "[relabeler-entrypoint] relabel-worker cycle exited with an error, will retry after the interval" >&2
  fi
  echo "[relabeler-entrypoint] sleeping for ${INTERVAL_SECONDS}s"
  sleep "${INTERVAL_SECONDS}"
done
