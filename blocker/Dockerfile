FROM node:24-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY blocker/package.json blocker/package.json
COPY twitter-client/package.json twitter-client/package.json
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate && pnpm install --frozen-lockfile

COPY prisma ./prisma
COPY twitter-client ./twitter-client
COPY blocker ./blocker
RUN pnpm --filter twitter-client run build
RUN pnpm --filter blocker run db:generate
RUN pnpm --filter blocker run build

FROM node:24-bookworm-slim

ARG APPLICATION_VERSION=unknown
ENV APPLICATION_VERSION=$APPLICATION_VERSION

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/blocker/node_modules ./blocker/node_modules
COPY --from=build /app/blocker/dist ./blocker/dist
COPY --from=build /app/twitter-client/dist ./twitter-client/dist
COPY --from=build /app/twitter-client/package.json ./twitter-client/package.json
COPY --from=build /app/twitter-client/node_modules ./twitter-client/node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/blocker ./blocker
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/pnpm-lock.yaml ./pnpm-lock.yaml

COPY blocker/entrypoint.sh ./blocker-entrypoint.sh
RUN chmod +x blocker-entrypoint.sh
WORKDIR /app/blocker
ENTRYPOINT ["/app/blocker-entrypoint.sh"]
