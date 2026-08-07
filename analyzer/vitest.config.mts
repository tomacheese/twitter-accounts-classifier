import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    // read-models 系のテストはテーブル全体を走査するため、ファイル間の並列実行では
    // 他ファイルが投入した行を拾ってしまい結果が不安定になる。DB を共有する統合テスト
    // である以上、ファイルをシリアルに実行して隔離する。
    fileParallelism: false,
  },
})
