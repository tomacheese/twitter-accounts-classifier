/**
 * `items` の各要素に対して1回ずつ `task` を実行するが、同時実行数を最大 `concurrency`
 * 件に制限する。`Promise.all(items.map(task))` と異なり、DB コネクションプールなど
 * 有限のリソースを使う呼び出し元が、全件を一度に同時実行して溢れさせることを防ぐ。
 * いずれかの `task` が reject した場合、既に実行中の `task` はキャンセルされず
 * 完了まで走り続けるが、まだ着手していない要素の新規実行は打ち切る。呼び出し元には
 * 最初に reject した1件のエラーだけが伝播し (以降に reject した分は握りつぶされる)、
 * これは並列処理一般の制約であり `task` 自体を呼び出し元で try/catch していれば
 * 到達しない。
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
