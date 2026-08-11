import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // これがないと `@/` で import したモジュールをテスト実行時に解決できない。
  resolve: {
    alias: {
      '@': dirname,
    },
  },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'app/**/*.test.tsx'],
    // DB を使うテストは同一の Postgres インスタンスへ書き込むため、ファイル単位で並列実行すると相互のデータがレースする。
    // fileParallelism を無効にし、テストファイルを直列に実行する。
    fileParallelism: false,
  },
})
