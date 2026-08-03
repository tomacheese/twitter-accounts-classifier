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
  },
})
