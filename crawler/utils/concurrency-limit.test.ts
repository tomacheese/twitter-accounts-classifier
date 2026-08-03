import { describe, expect, it } from 'vitest'
import { runWithConcurrencyLimit } from './concurrency-limit'

describe('runWithConcurrencyLimit', () => {
  it('runs task exactly once for every item', async () => {
    const seen: number[] = []
    await runWithConcurrencyLimit([1, 2, 3, 4, 5], 2, (item) => {
      seen.push(item)
      return Promise.resolve()
    })
    // eslint-disable-next-line unicorn/no-array-sort -- toSorted() が使えないため複製へ sort()
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it('never runs more than `concurrency` tasks at the same time', async () => {
    let inFlight = 0
    let maxInFlight = 0
    await runWithConcurrencyLimit(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 1))
        inFlight--
      },
    )
    expect(maxInFlight).toBeLessThanOrEqual(3)
  })

  it('clamps concurrency to the item count when concurrency exceeds it', async () => {
    let inFlight = 0
    let maxInFlight = 0
    await runWithConcurrencyLimit([1, 2], 10, async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight--
    })
    expect(maxInFlight).toBe(2)
  })

  it('propagates a task rejection while letting already-started tasks finish', async () => {
    const completed: number[] = []
    await expect(
      runWithConcurrencyLimit([1, 2, 3], 3, async (item) => {
        if (item === 2) throw new Error('boom')
        await new Promise((resolve) => setTimeout(resolve, 1))
        completed.push(item)
      }),
    ).rejects.toThrow('boom')
    // Promise.all は item 2 が throw したマイクロタスクの時点で reject するため、
    // item 1/3 の1msタイマーが発火する前に到達する。
    // 既に開始済みのタスクがキャンセルされていないことを確認する前に、
    // その完了を待つ猶予を与える。
    await new Promise((resolve) => setTimeout(resolve, 10))
    // eslint-disable-next-line unicorn/no-array-sort -- toSorted() が使えないため複製へ sort()
    expect([...completed].sort((a, b) => a - b)).toEqual([1, 3])
  })

  it('does not start a not-yet-begun item once an earlier task has rejected', async () => {
    // concurrency: 1 なので item は逐次実行される。
    // item 2 が reject した時点で item 3 はまだ着手していないため、
    // バックグラウンドで実行が継続していれば item 3 も started に記録されてしまう。
    const started: number[] = []
    await expect(
      runWithConcurrencyLimit([1, 2, 3], 1, (item) => {
        started.push(item)
        if (item === 2) return Promise.reject(new Error('boom'))
        return Promise.resolve()
      }),
    ).rejects.toThrow('boom')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(started).toEqual([1, 2])
  })
})
