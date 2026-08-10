FROM node:24-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY crawler/package.json crawler/package.json
COPY twitter-client/package.json twitter-client/package.json
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate && pnpm install --frozen-lockfile

COPY prisma ./prisma
COPY twitter-client ./twitter-client
COPY crawler ./crawler
RUN pnpm --filter twitter-client run build
RUN pnpm --filter crawler run db:generate
RUN pnpm --filter crawler run build

# production dependencyのみを自己完結ディレクトリへ切り出す。twitter-clientは
# workspace:*参照だがpnpm-workspace.yamlのinjectWorkspacePackages: trueにより
# symlinkでなく実体としてコピーされる。
ARG TARGETARCH
RUN pnpm --filter crawler deploy --prod /app/deploy/crawler

# cycletlsはLinux/macOS/Windows/FreeBSD向けバイナリを全て同梱しているが、
# 実行時に使うのは対象archのLinuxバイナリ1本のみ。.pnpm配下の実体ディレクトリを
# バージョン文字列に依存せず動的に探索し、対象arch以外のバイナリを削除する。
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) keep=index ;; \
      arm64) keep=index-arm64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    cycletls_pkg=$(find /app/deploy/crawler/node_modules/.pnpm -maxdepth 4 -type d -path '*/cycletls@*/node_modules/cycletls' -print -quit); \
    if [ -z "$cycletls_pkg" ]; then echo "cycletls package not found" >&2; exit 1; fi; \
    find "$cycletls_pkg/dist" -maxdepth 1 -type f ! -name "$keep" ! -name 'index.js' ! -name 'index.d.ts' -delete

FROM node:24-bookworm-slim

# reusable-docker.yml が渡す APPLICATION_VERSION (semver) を実行時に process.env から読めるよう
# ENV へ引き継ぐ。CrawlAccountRun.appVersion に記録し、warning がどのビルドで発生したか追跡する。
ARG APPLICATION_VERSION=unknown
ENV APPLICATION_VERSION=$APPLICATION_VERSION
ARG GIT_REVISION=unknown
ENV GIT_REVISION=$GIT_REVISION
ARG BUILD_TIME=unknown
ENV BUILD_TIME=$BUILD_TIME

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates postgresql-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=build /app/crawler ./crawler
# COPYはディレクトリを上書きせずマージするため、buildステージのnode_modules
# (devDependencyを含むsymlink構成) を明示的に削除してからdeploy済みの
# production dependencyのみのnode_modulesに置き換える。
RUN rm -rf ./crawler/node_modules
COPY --from=build /app/deploy/crawler/node_modules ./crawler/node_modules
COPY --from=build /app/prisma ./prisma
COPY scripts ./scripts

COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh
WORKDIR /app/crawler
ENTRYPOINT ["/app/entrypoint.sh"]
