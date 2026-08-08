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

FROM node:24-bookworm-slim

ARG APPLICATION_VERSION=unknown
ENV APPLICATION_VERSION=$APPLICATION_VERSION

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/analyzer/node_modules ./analyzer/node_modules
COPY --from=build /app/analyzer/dist ./analyzer/dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/analyzer ./analyzer
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/pnpm-lock.yaml ./pnpm-lock.yaml

COPY analyzer/entrypoint.sh ./analyzer-entrypoint.sh
RUN chmod +x analyzer-entrypoint.sh
WORKDIR /app/analyzer
ENTRYPOINT ["/app/analyzer-entrypoint.sh"]
