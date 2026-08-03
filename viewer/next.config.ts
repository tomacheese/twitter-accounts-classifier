import path from 'node:path'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // standalone 出力にすると各ルートが実際に必要とするファイルだけがトレースされ、
  // ランタイムイメージで node_modules 全体をコピーする必要がなくなるため、この設定にしている。
  output: 'standalone',
  // pnpm はワークスペース共有の依存関係をワークスペースルートの node_modules/.pnpm に集約し、
  // viewer/node_modules 以下はそこへのシンボリックリンクにすぎないため、
  // viewer/ を起点にトレースするとリンク切れ (実行時に "Cannot find module 'next'") を起こす。
  // そのためワークスペースルートを明示的に指定している。
  // 値を未設定のままにすると、
  // Next.js が祖先ディレクトリを辿って無関係な pnpm-lock.yaml (ネストしたワークツリーなど) を見つけてしまう。
  outputFileTracingRoot: path.join(import.meta.dirname, '..'),
  images: {
    // Account.profileImageUrl は Twitter (X) 自身の CDN から直接取得されるため、
    // next/image が取得できるようホスト名を明示的に許可リストへ登録する必要がある。
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'pbs.twimg.com',
      },
    ],
  },
}

export default nextConfig
