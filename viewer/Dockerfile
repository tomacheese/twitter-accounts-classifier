FROM node:24-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY crawler/package.json crawler/package.json
COPY viewer/package.json viewer/package.json
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate && pnpm install --frozen-lockfile

COPY prisma ./prisma
COPY viewer ./viewer
RUN pnpm --filter viewer run db:generate
RUN pnpm --filter viewer run build

# `output: 'standalone'` traces only the files each route actually needs, so
# the runtime stage below copies that minimal bundle instead of the full
# node_modules tree, and runs the bundle's own server.js directly — no pnpm
# or package manager needed at runtime. outputFileTracingRoot in
# next.config.ts is pinned to the pnpm workspace root (one level above
# viewer/), so the traced bundle mirrors that layout: shared deps land at
# .next/standalone/node_modules, and the app itself lands nested at
# .next/standalone/viewer/ rather than at the standalone root.
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
