FROM node:24-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY crawler/package.json crawler/package.json
COPY viewer/package.json viewer/package.json
COPY pipeline-health/package.json pipeline-health/package.json
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate && pnpm install --frozen-lockfile

COPY prisma ./prisma
COPY viewer ./viewer
COPY pipeline-health ./pipeline-health
RUN pnpm --filter viewer run db:generate
RUN pnpm --filter viewer run build

# `output: 'standalone'` は各ルートが実際に必要とするファイルだけをトレースする。
# そのため後続の runtime ステージでは node_modules 全体ではなくこの最小バンドルをコピーし、
# バンドル自身の server.js を直接実行する (実行時に pnpm などのパッケージマネージャーは不要)。
# next.config.ts の outputFileTracingRoot は pnpm workspace のルート (viewer/ の 1 つ上) に固定されている。
# このためトレース結果もその構成を反映し、共有依存は .next/standalone/node_modules に、
# アプリ本体は standalone ルートではなく .next/standalone/viewer/ にネストして配置される。
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

COPY --from=build /app/viewer/.next/standalone ./
COPY --from=build /app/viewer/.next/static ./viewer/.next/static
COPY --from=build /app/viewer/public ./viewer/public

EXPOSE 3000
CMD ["node", "viewer/server.js"]
