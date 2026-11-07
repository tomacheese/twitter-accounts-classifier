import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // id-boundary の dist は .gitignore 対象で CI では未ビルドのため、テスト実行時はソースを直接解決する。
    alias: {
      'id-boundary': fileURLToPath(new URL('../id-boundary/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    // read-models 系のテストはテーブル全体を走査するため、ファイル間の並列実行では
    // 他ファイルが投入した行を拾ってしまい結果が不安定になる。DB を共有する統合テスト
    // である以上、ファイルをシリアルに実行して隔離する。
    fileParallelism: false,
  },
})
