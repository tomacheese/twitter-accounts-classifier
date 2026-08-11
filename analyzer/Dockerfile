FROM node:24-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY analyzer/package.json analyzer/package.json
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate && pnpm install --frozen-lockfile

COPY prisma ./prisma
COPY analyzer ./analyzer
RUN pnpm --filter analyzer run db:generate
RUN pnpm --filter analyzer run build
RUN test -f /app/analyzer/dist/policy/detection-policy.json

# analyzer は twitter-client に依存しないため cycletls は含まれず、prune は不要。
RUN pnpm --filter analyzer deploy --prod /app/deploy/analyzer

# typescript は @prisma/client の optional peer dependency として解決されるだけで、実行時には使われない。
RUN find /app/deploy/analyzer/node_modules/.pnpm -maxdepth 1 -type d -name 'typescript@*' -exec rm -rf {} +

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

COPY --from=build /app/deploy/analyzer/node_modules ./analyzer/node_modules
COPY --from=build /app/analyzer/dist ./analyzer/dist

COPY analyzer/entrypoint.sh ./analyzer-entrypoint.sh
RUN chmod +x analyzer-entrypoint.sh
WORKDIR /app/analyzer
ENTRYPOINT ["/app/analyzer-entrypoint.sh"]
