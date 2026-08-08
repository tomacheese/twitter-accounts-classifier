import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getWorkerConcurrency } from './env'

describe('config/env', () => {
  const originalConcurrency = process.env.ANALYZER_WORKER_CONCURRENCY

  beforeEach(() => {
    delete process.env.ANALYZER_WORKER_CONCURRENCY
  })

  afterEach(() => {
    process.env.ANALYZER_WORKER_CONCURRENCY = originalConcurrency
  })

  it('getWorkerConcurrency は未設定時に 1 を返す', () => {
    expect(getWorkerConcurrency()).toBe(1)
  })

  it('getWorkerConcurrency は設定値を数値として返す', () => {
    process.env.ANALYZER_WORKER_CONCURRENCY = '4'
    expect(getWorkerConcurrency()).toBe(4)
  })

  it('getWorkerConcurrency は不正な値で例外を投げる', () => {
    process.env.ANALYZER_WORKER_CONCURRENCY = '0'
    expect(() => getWorkerConcurrency()).toThrow()
  })
})
