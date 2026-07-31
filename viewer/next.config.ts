import path from 'node:path'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Traces only the files each route actually needs into .next/standalone,
  // so the runtime image can skip copying the full node_modules tree.
  output: 'standalone',
  // Must be the pnpm workspace root, not viewer/ itself: pnpm hoists shared
  // deps into the workspace root's node_modules/.pnpm and viewer/node_modules/*
  // are only symlinks into it, so tracing rooted at viewer/ copies dangling
  // symlinks ("Cannot find module 'next'" at runtime). Pinned explicitly rather
  // than left unset, since Next.js would then walk up until it found some
  // ancestor's unrelated pnpm-lock.yaml — e.g. for a nested worktree checkout.
  outputFileTracingRoot: path.join(import.meta.dirname, '..'),
  images: {
    // Account.profileImageUrl is sourced directly from Twitter's own CDN, so
    // remote images must be explicitly allow-listed by hostname for
    // next/image to fetch them.
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'pbs.twimg.com',
      },
    ],
  },
}

export default nextConfig
