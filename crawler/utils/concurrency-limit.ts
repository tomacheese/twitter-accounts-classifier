/**
 * `items` の各要素に対して1回ずつ `task` を実行するが、同時実行数を最大 `concurrency`
 * 件に制限する。`Promise.all(items.map(task))` と異なり、DBコネクションプールなど
 * 有限のリソースを使う呼び出し元が、全件を一度に同時実行して溢れさせることを防ぐ。
 * @param items - 処理対象の要素
 * @param concurrency - 同時実行数の上限 (`items.length` より大きい場合はそちらに丸められる)
 * @param task - 各要素に対して実行する非同期処理
 */
export async function runWithConcurrencyLimit<T>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      await task(items[index], index)
    }
  }

  const workerCount = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
}
