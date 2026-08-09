import { describe, expect, it } from 'vitest'
import { deriveBlockStageStatus } from './build-block-cycle'

describe('deriveBlockStageStatus', () => {
  it('BlockRun completed を succeeded に正規化する', () => {
    expect(deriveBlockStageStatus('completed')).toBe('succeeded')
  })

  it('BlockRun failed を failed に正規化する', () => {
    expect(deriveBlockStageStatus('failed')).toBe('failed')
  })
})
