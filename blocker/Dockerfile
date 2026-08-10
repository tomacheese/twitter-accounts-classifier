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

# production dependencyのみを自己完結ディレクトリへ切り出す。twitter-clientは
# workspace:*参照だがpnpm-workspace.yamlのinjectWorkspacePackages: trueにより
# symlinkでなく実体としてコピーされる。
ARG TARGETARCH
RUN pnpm --filter blocker deploy --prod /app/deploy/blocker

# cycletlsはLinux/macOS/Windows/FreeBSD向けバイナリを全て同梱しているが、
# 実行時に使うのは対象archのLinuxバイナリ1本のみ。.pnpm配下の実体ディレクトリを
# バージョン文字列に依存せず動的に探索し、対象arch以外のバイナリを削除する。
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) keep=index ;; \
      arm64) keep=index-arm64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    cycletls_pkg=$(find /app/deploy/blocker/node_modules/.pnpm -maxdepth 4 -type d -path '*/cycletls@*/node_modules/cycletls' -print -quit); \
    if [ -z "$cycletls_pkg" ]; then echo "cycletls package not found" >&2; exit 1; fi; \
    find "$cycletls_pkg/dist" -maxdepth 1 -type f ! -name "$keep" ! -name 'index.js' ! -name 'index.d.ts' -delete

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
