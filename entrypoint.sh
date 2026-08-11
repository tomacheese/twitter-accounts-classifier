#!/bin/sh
set -eu

# prisma db seed は内部で tsx ../prisma/seed.ts を子プロセスとして spawn するため、PATH に無いと spawn tsx ENOENT になる。
export PATH="/app/crawler/node_modules/.bin:$PATH"

# `docker compose run crawler <command>` passes <command> as $@; without this, the
# container ignored it and always fell through to the crawl loop below, making one-off
# commands (e.g. `node dist/relabel.js`) silently run a full crawl cycle instead.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

INTERVAL_SECONDS="${CRAWL_INTERVAL_SECONDS:-21600}"

cd /app/crawler

echo "[entrypoint] applying database migrations"
prisma migrate deploy --schema=../prisma/schema.prisma

echo "[entrypoint] syncing and verifying role grants"
(cd /app && bash scripts/db/run-migration-and-sync-grants.sh)

echo "[entrypoint] seeding label definitions"
prisma db seed --schema=../prisma/schema.prisma

while true; do
  echo "[entrypoint] starting crawl cycle at $(date -Iseconds)"
  if ! node dist/crawl.js; then
    echo "[entrypoint] crawl cycle exited with an error, will retry after the interval" >&2
  fi
  echo "[entrypoint] starting relabel-worker cycle at $(date -Iseconds)"
  if ! node dist/relabel-worker.js; then
    echo "[entrypoint] relabel-worker cycle exited with an error, will retry after the interval" >&2
  fi
  echo "[entrypoint] sleeping for ${INTERVAL_SECONDS}s"
  sleep "${INTERVAL_SECONDS}"
done
