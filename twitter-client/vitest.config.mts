import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    // パッケージ分割の移行過程でテストファイルが未配置になる期間があるため、
    // テストが0件でも check コマンドが失敗しないようにしている。
    passWithNoTests: true,
  },
})
