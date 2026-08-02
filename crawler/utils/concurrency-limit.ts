/**
 * `items` の各要素に `task` を1回ずつ実行するが、同時実行数を `concurrency` 件に制限する。
 * `Promise.all(items.map(task))` と異なり、DB コネクションプールなど有限のリソースを
 * 全件同時実行で溢れさせない。いずれかの `task` が reject すると、未着手の要素は打ち切るが
 * 実行中の `task` は完了まで走らせる。呼び出し元には最初の reject だけが伝播する。
 * @param items - 処理対象の要素
 * @param concurrency - 同時実行数の上限 (`items.length` より大きい場合は丸められる)
 * @param task - 各要素に対して実行する非同期処理
 */
export async function runWithConcurrencyLimit<T>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0
  let stopped = false

  async function worker(): Promise<void> {
    for (;;) {
      if (stopped) return
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      try {
        await task(items[index], index)
      } catch (error) {
        stopped = true
        throw error
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
}
