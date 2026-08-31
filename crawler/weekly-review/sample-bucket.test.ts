import { describe, expect, it } from 'vitest'
import {
  assignBucket,
  computeBucketReadCount,
  selectBuckets,
  BUCKET_COUNT,
  OVERSAMPLE_FACTOR,
} from './sample-bucket'

describe('assignBucket', () => {
  it('同一 accountId には常に同一 bucket を返す', () => {
    const accountId = 'account-1234567890'
    expect(assignBucket(accountId)).toBe(assignBucket(accountId))
  })

  it('0..4095 の範囲に収まる', () => {
    for (const accountId of ['a', 'bb', 'account-xyz', '0', '文字列']) {
      const bucket = assignBucket(accountId)
      expect(bucket).toBeGreaterThanOrEqual(0)
      expect(bucket).toBeLessThan(BUCKET_COUNT)
    }
  })
})

describe('computeBucketReadCount', () => {
  it('populationCount が 0 以下なら呼び出しを許可しない', () => {
    expect(() => computeBucketReadCount(0, 10, OVERSAMPLE_FACTOR)).toThrow()
    expect(() => computeBucketReadCount(-1, 10, OVERSAMPLE_FACTOR)).toThrow()
  })

  it('N <= poolSize * oversample の小母集団では全 bucket (4096) を読む', () => {
    const poolSize = 10
    const oversample = OVERSAMPLE_FACTOR
    expect(computeBucketReadCount(poolSize * oversample, poolSize, oversample)).toBe(BUCKET_COUNT)
    expect(computeBucketReadCount(1, poolSize, oversample)).toBe(BUCKET_COUNT)
  })

  it('N が非常に大きい母集団では M が 1 以上になる', () => {
    expect(computeBucketReadCount(100_000_000, 10, OVERSAMPLE_FACTOR)).toBeGreaterThanOrEqual(1)
  })

  it('M は 4096 を超えない', () => {
    expect(computeBucketReadCount(1, 10, OVERSAMPLE_FACTOR)).toBeLessThanOrEqual(BUCKET_COUNT)
  })
})

describe('selectBuckets', () => {
  it('同じ入力なら同じ bucket 集合を返す', () => {
    const first = selectBuckets('run-1', 'label-1', true, 16)
    const second = selectBuckets('run-1', 'label-1', true, 16)
    expect(second).toEqual(first)
  })

  it('返す件数は要求した m と一致する', () => {
    expect(selectBuckets('run-1', 'label-1', true, 16)).toHaveLength(16)
    expect(selectBuckets('run-1', 'label-1', true, BUCKET_COUNT)).toHaveLength(BUCKET_COUNT)
  })

  it('異なる seed (runId) では選ばれる bucket 集合が変わる', () => {
    const a = selectBuckets('run-1', 'label-1', true, 16)
    const b = selectBuckets('run-2', 'label-1', true, 16)
    expect(new Set(a)).not.toEqual(new Set(b))
  })

  it('value が異なれば選ばれる bucket 集合も変わる', () => {
    const a = selectBuckets('run-1', 'label-1', true, 16)
    const b = selectBuckets('run-1', 'label-1', false, 16)
    expect(new Set(a)).not.toEqual(new Set(b))
  })

  it('返す bucket は重複がなく 0..4095 の範囲に収まる', () => {
    const buckets = selectBuckets('run-1', 'label-1', true, 64)
    expect(new Set(buckets).size).toBe(buckets.length)
    for (const bucket of buckets) {
      expect(bucket).toBeGreaterThanOrEqual(0)
      expect(bucket).toBeLessThan(BUCKET_COUNT)
    }
  })
})
