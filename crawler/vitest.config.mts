import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // twitter-client の dist は .gitignore 対象で CI では未ビルドのため、
    // テスト実行時はビルド済み dist ではなくソースを直接解決する。
    alias: {
      'twitter-client': fileURLToPath(new URL('../twitter-client/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
  },
})
