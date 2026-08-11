import { describe, expect, it, vi } from 'vitest'
import { TimeoutError, withTimeout } from './timeout'

describe('withTimeout', () => {
  it('resolves with the inner promise value when it settles before the timeout', async () => {
    const inner = new Promise<string>((resolve) =>
      setTimeout(() => {
        resolve('ok')
      }, 5),
    )

    const result = await withTimeout(inner, 50, 'should not time out')

    expect(result).toBe('ok')
  })

  it('rejects with the inner promise error when it rejects before the timeout', async () => {
    const innerError = new Error('inner failure')
    const inner = new Promise<never>((_resolve, reject) =>
      setTimeout(() => {
        reject(innerError)
      }, 5),
    )

    await expect(withTimeout(inner, 50, 'should not time out')).rejects.toBe(innerError)
  })

  it('rejects with TimeoutError when the inner promise does not settle in time', async () => {
    const inner = new Promise<never>(() => {
      // 意図的に永遠に settle しない: cycletls 子プロセスのハングを模する。
    })

    await expect(withTimeout(inner, 5, 'timed out waiting for inner')).rejects.toThrow(TimeoutError)
    await expect(withTimeout(inner, 5, 'timed out waiting for inner')).rejects.toThrow(
      'timed out waiting for inner',
    )
  })

  it('does not leave a pending timer once the inner promise settles first', async () => {
    vi.useFakeTimers()
    try {
      const inner = Promise.resolve('ok')

      await withTimeout(inner, 50, 'should not time out')

      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
