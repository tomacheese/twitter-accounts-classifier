FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY crawler/package.json crawler/package.json
COPY viewer/package.json viewer/package.json
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate && pnpm install --frozen-lockfile
COPY prisma ./prisma
COPY crawler ./crawler
RUN pnpm --filter crawler run db:generate
RUN pnpm --filter crawler run build

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/crawler/node_modules ./crawler/node_modules
COPY --from=build /app/crawler/dist ./crawler/dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/crawler ./crawler
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh
WORKDIR /app/crawler
ENTRYPOINT ["/app/entrypoint.sh"]
