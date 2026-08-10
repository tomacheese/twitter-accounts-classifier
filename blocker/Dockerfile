FROM node:24-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY blocker/package.json blocker/package.json
COPY twitter-client/package.json twitter-client/package.json
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate && pnpm install --frozen-lockfile

COPY prisma ./prisma
COPY twitter-client ./twitter-client
COPY blocker ./blocker
RUN pnpm --filter twitter-client run build
RUN pnpm --filter blocker run db:generate
RUN pnpm --filter blocker run build

# twitter-client は workspace:* 参照だが、pnpm-workspace.yaml の injectWorkspacePackages: true により symlink でなく実体としてコピーされる。
ARG TARGETARCH
RUN pnpm --filter blocker deploy --prod /app/deploy/blocker

# cycletls は Linux/macOS/Windows/FreeBSD 向けバイナリを全て同梱しているが、実行時に使うのは対象 arch の Linux バイナリ1本のみ。
# パッケージパスをバージョン文字列で固定すると pnpm のバージョン更新で壊れるため、動的に探索する。
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) keep=index ;; \
      arm64) keep=index-arm64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    cycletls_pkg=$(find /app/deploy/blocker/node_modules/.pnpm -maxdepth 4 -type d -path '*/cycletls@*/node_modules/cycletls' -print -quit); \
    if [ -z "$cycletls_pkg" ]; then echo "cycletls package not found" >&2; exit 1; fi; \
    if [ ! -f "$cycletls_pkg/dist/$keep" ]; then echo "cycletls binary $keep not found" >&2; exit 1; fi; \
    find "$cycletls_pkg/dist" -maxdepth 1 -type f ! -name "$keep" ! -name 'index.js' ! -name 'index.d.ts' -delete

# typescript は @prisma/client の optional peer dependency として解決されるだけで、実行時には使われない。
RUN find /app/deploy/blocker/node_modules/.pnpm -maxdepth 1 -type d -name 'typescript@*' -exec rm -rf {} +

FROM node:24-bookworm-slim

ARG APPLICATION_VERSION=unknown
ENV APPLICATION_VERSION=$APPLICATION_VERSION
ARG GIT_REVISION=unknown
ENV GIT_REVISION=$GIT_REVISION
ARG BUILD_TIME=unknown
ENV BUILD_TIME=$BUILD_TIME

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=build /app/deploy/blocker/node_modules ./blocker/node_modules
COPY --from=build /app/blocker/dist ./blocker/dist

COPY blocker/entrypoint.sh ./blocker-entrypoint.sh
RUN chmod +x blocker-entrypoint.sh
WORKDIR /app/blocker
ENTRYPOINT ["/app/blocker-entrypoint.sh"]
