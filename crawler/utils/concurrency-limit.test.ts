import { describe, expect, it } from 'vitest'
import { runWithConcurrencyLimit } from './concurrency-limit'

describe('runWithConcurrencyLimit', () => {
  it('runs task exactly once for every item', async () => {
    const seen: number[] = []
    await runWithConcurrencyLimit([1, 2, 3, 4, 5], 2, (item) => {
      seen.push(item)
      return Promise.resolve()
    })
    // eslint-disable-next-line unicorn/no-array-sort -- toSorted() requires ES2023 lib, but tsconfig targets ES2022; sorting a spread copy avoids mutating the input
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
    // Promise.all rejects on the microtask where item 2 throws, before items 1/3's
    // 1ms timers fire, so give those already-started tasks a chance to finish before
    // asserting they weren't cancelled.
    await new Promise((resolve) => setTimeout(resolve, 10))
    // eslint-disable-next-line unicorn/no-array-sort -- toSorted() requires ES2023 lib, but tsconfig targets ES2022; sorting a spread copy avoids mutating the input
    expect([...completed].sort((a, b) => a - b)).toEqual([1, 3])
  })
})
