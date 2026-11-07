#!/bin/sh
set -eu

# prisma db seed は内部で tsx ../prisma/seed.ts を子プロセスとして spawn するため、PATH に無いと spawn tsx ENOENT になる。
export PATH="/app/crawler/node_modules/.bin:$PATH"

# `docker compose run crawler <command>` は <command> を $@ として渡す。
# この分岐が無いと引数が無視されて常に下のクロールループへ進み、
# 単発コマンド (例: `node dist/relabel.js`) の代わりにクロールサイクルが走ってしまう。
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

INTERVAL_SECONDS="${CRAWL_INTERVAL_SECONDS:-21600}"

cd /app/crawler

echo "[entrypoint] seeding label definitions"
prisma db seed --schema=../prisma/schema.prisma

while true; do
  echo "[entrypoint] starting crawl cycle at $(date -Iseconds)"
  if ! node dist/crawl.js; then
    echo "[entrypoint] crawl cycle exited with an error, will retry after the interval" >&2
  fi
  echo "[entrypoint] sleeping for ${INTERVAL_SECONDS}s"
  sleep "${INTERVAL_SECONDS}"
done
