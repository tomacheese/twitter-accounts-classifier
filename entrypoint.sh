#!/bin/sh
set -eu

# `docker compose run crawler <command>` passes <command> as $@; without this, the
# container ignored it and always fell through to the crawl loop below, making one-off
# commands (e.g. `node dist/relabel.js`) silently run a full crawl cycle instead.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

INTERVAL_SECONDS="${CRAWL_INTERVAL_SECONDS:-21600}"

cd /app/crawler

echo "[entrypoint] applying database migrations"
pnpm exec prisma migrate deploy --schema=../prisma/schema.prisma

echo "[entrypoint] seeding label definitions"
pnpm exec prisma db seed --schema=../prisma/schema.prisma

while true; do
  echo "[entrypoint] starting crawl cycle at $(date -Iseconds)"
  if ! node dist/crawl.js; then
    echo "[entrypoint] crawl cycle exited with an error, will retry after the interval" >&2
  fi
  echo "[entrypoint] sleeping for ${INTERVAL_SECONDS}s"
  sleep "${INTERVAL_SECONDS}"
done
