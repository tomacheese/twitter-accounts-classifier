import { describe, it, expect } from 'vitest'
import { computeBlockReconciliation } from './block-reconciliation'

describe('computeBlockReconciliation', () => {
  it('完全同期で対象が存在しない場合のみ missing count を進める', () => {
    const result = computeBlockReconciliation({
      existingStatus: 'active',
      consecutiveMissingCount: 0,
      isPresent: false,
      isCompleteSync: true,
    })
    expect(result.nextStatus).toBe('missing')
    expect(result.consecutiveMissingCount).toBe(1)
  })

  it('不完全な取得では absence を確定しない', () => {
    const result = computeBlockReconciliation({
      existingStatus: 'active',
      consecutiveMissingCount: 0,
      isPresent: false,
      isCompleteSync: false,
    })
    expect(result.nextStatus).toBe('active')
    expect(result.consecutiveMissingCount).toBe(0)
  })

  it('連続 missing 条件を満たすと resolved になる', () => {
    const result = computeBlockReconciliation({
      existingStatus: 'missing',
      consecutiveMissingCount: 2,
      isPresent: false,
      isCompleteSync: true,
      resolutionCount: 3,
    })
    expect(result.nextStatus).toBe('resolved')
  })

  it('再び observed されれば active へ戻る', () => {
    const result = computeBlockReconciliation({
      existingStatus: 'missing',
      consecutiveMissingCount: 1,
      isPresent: true,
      isCompleteSync: true,
    })
    expect(result.nextStatus).toBe('active')
    expect(result.consecutiveMissingCount).toBe(0)
  })
})
