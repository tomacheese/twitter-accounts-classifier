import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getPrismaClient } from '../db/client'
import { runLabelFindingsSerialized } from './serialize-label-findings'

const DETECTOR_KEY = 'label_findings'

describe.skipIf(!process.env.DATABASE_URL)('runLabelFindingsSerialized', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.detectorState.deleteMany({ where: { detectorKey: DETECTOR_KEY } })
  })

  it('skips run when snapshotAt is not newer than the recorded watermark', async () => {
    await prisma.detectorState.create({
      data: {
        detectorKey: DETECTOR_KEY,
        sourceWatermarkAt: new Date('2026-08-05T00:00:00Z'),
      },
    })

    const run = vi.fn().mockResolvedValue(undefined)
    await runLabelFindingsSerialized(prisma, {
      evidenceEpochId: 'epoch-old',
      sourceWatermarkAt: new Date('2026-08-04T00:00:00Z'),
      policyHash: 'policy-hash',
      analyzerVersion: 'version-1',
      run,
    })

    expect(run).not.toHaveBeenCalled()
    const state = await prisma.detectorState.findUniqueOrThrow({
      where: { detectorKey: DETECTOR_KEY },
    })
    expect(state.sourceWatermarkAt?.toISOString()).toBe(
      new Date('2026-08-05T00:00:00Z').toISOString(),
    )
  })

  it('runs and advances the watermark when snapshotAt is newer', async () => {
    await prisma.detectorState.create({
      data: {
        detectorKey: DETECTOR_KEY,
        sourceWatermarkAt: new Date('2026-08-04T00:00:00Z'),
      },
    })

    const run = vi.fn().mockResolvedValue(undefined)
    await runLabelFindingsSerialized(prisma, {
      evidenceEpochId: 'epoch-new',
      sourceWatermarkAt: new Date('2026-08-05T00:00:00Z'),
      policyHash: 'policy-hash',
      analyzerVersion: 'version-1',
      run,
    })

    expect(run).toHaveBeenCalledTimes(1)
    const state = await prisma.detectorState.findUniqueOrThrow({
      where: { detectorKey: DETECTOR_KEY },
    })
    expect(state.sourceWatermarkAt?.toISOString()).toBe(
      new Date('2026-08-05T00:00:00Z').toISOString(),
    )
    expect(state.lastEvidenceEpochId).toBe('epoch-new')
  })

  it('records failed status even when this is the first-ever run (no pre-existing row)', async () => {
    const run = vi.fn().mockRejectedValue(new Error('boom'))

    await expect(
      runLabelFindingsSerialized(prisma, {
        evidenceEpochId: 'epoch-failed',
        sourceWatermarkAt: new Date('2026-08-05T00:00:00Z'),
        policyHash: 'policy-hash',
        analyzerVersion: 'version-1',
        run,
      }),
    ).rejects.toThrow('boom')

    const state = await prisma.detectorState.findUniqueOrThrow({
      where: { detectorKey: DETECTOR_KEY },
    })
    expect(state.errorSummary).toContain('boom')
  })
})

describe('runLabelFindingsSerialized without a database', () => {
  it('locks and advances DetectorState using the evidence watermark', async () => {
    const executeRaw = vi.fn().mockResolvedValue(1)
    const queryRaw = vi.fn().mockResolvedValue([{ sourceWatermarkAt: null }])
    const update = vi.fn().mockResolvedValue({})
    const run = vi.fn().mockResolvedValue(undefined)
    const tx = { $executeRaw: executeRaw, $queryRaw: queryRaw, detectorState: { update } }
    const prisma = {
      $transaction: vi.fn((callback: (client: typeof tx) => Promise<void>) => callback(tx)),
      detectorState: { upsert: vi.fn() },
    }
    const sourceWatermarkAt = new Date('2026-08-13T03:00:00Z')
    const input = {
      snapshotAt: sourceWatermarkAt,
      evidenceEpochId: 'epoch-1',
      sourceWatermarkAt,
      policyHash: 'policy-hash',
      analyzerVersion: 'version-1',
      run,
    }

    await runLabelFindingsSerialized(prisma as never, input)

    const firstExecuteRawCall = executeRaw.mock.calls[0] as unknown[] | undefined
    const sqlFragments = firstExecuteRawCall?.[0] as TemplateStringsArray | undefined
    expect(sqlFragments?.join('')).toContain('"DetectorState"')
    expect(update).toHaveBeenCalledWith({
      where: { detectorKey: DETECTOR_KEY },
      data: {
        lastEvidenceEpochId: 'epoch-1',
        sourceWatermarkAt,
        lastSuccessAt: expect.any(Date),
        policyHash: 'policy-hash',
        analyzerVersion: 'version-1',
        errorCode: null,
        errorSummary: null,
      },
    })
  })

  it('新しい evidence が成功済みなら古い evidence の失敗を記録しない', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ sourceWatermarkAt: null }])
      .mockResolvedValueOnce([{ sourceWatermarkAt: new Date('2026-08-13T04:00:00Z') }])
    const update = vi.fn().mockResolvedValue({})
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: queryRaw,
      detectorState: { update },
    }
    const prisma = {
      $transaction: vi.fn((callback: (client: typeof tx) => Promise<void>) => callback(tx)),
      detectorState: { upsert: vi.fn().mockResolvedValue({}) },
    }

    await expect(
      runLabelFindingsSerialized(prisma as never, {
        evidenceEpochId: 'epoch-old',
        sourceWatermarkAt: new Date('2026-08-13T03:00:00Z'),
        policyHash: 'policy-hash',
        analyzerVersion: 'version-1',
        run: vi.fn().mockRejectedValue(new Error('boom')),
      }),
    ).rejects.toThrow('boom')

    expect(update).not.toHaveBeenCalled()
  })
})
