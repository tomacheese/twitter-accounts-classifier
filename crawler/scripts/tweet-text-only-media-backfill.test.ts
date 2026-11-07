import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import {
  parseTextOnlyBackfillArgs,
  runTextOnlyMediaBackfill,
  type TextOnlyBackfillDependencies,
} from './tweet-text-only-media-backfill'

const REQUIRED_ARGS = [
  '--foreign-video-since',
  '2026-08-03T00:00:00Z',
  '--has-media-since',
  '2026-09-28T00:00:00Z',
]

// テストの Tweet は id ごとに accountId = `a${id}` の別アカウントに属する。
const key = (id: string) => ({ accountId: `a${id}`, id })

function makePrisma(windows: string[][], affectedPerWindow: number[]) {
  const queryRaw = vi.fn()
  for (const ids of windows) queryRaw.mockResolvedValueOnce(ids.map((id) => key(id)))
  queryRaw.mockResolvedValue([])
  const executeRaw = vi.fn()
  for (const affected of affectedPerWindow) executeRaw.mockResolvedValueOnce(affected)
  executeRaw.mockResolvedValue(0)
  return {
    prisma: { $queryRaw: queryRaw, $executeRaw: executeRaw } as unknown as PrismaClient,
    queryRaw,
    executeRaw,
  }
}

function makeDeps(prisma: PrismaClient): TextOnlyBackfillDependencies & { logs: string[] } {
  const logs: string[] = []
  return { prisma, sleep: vi.fn().mockResolvedValue(undefined), log: (m) => logs.push(m), logs }
}

describe('parseTextOnlyBackfillArgs', () => {
  it('requires both cutoffs so the evaluation boundary is always explicit', () => {
    expect(() => parseTextOnlyBackfillArgs([])).toThrow(
      '--foreign-video-since must be an ISO timestamp',
    )
    expect(() => parseTextOnlyBackfillArgs(REQUIRED_ARGS.slice(0, 2))).toThrow(
      '--has-media-since must be an ISO timestamp',
    )
  })

  it('defaults to dry-run with a single window and enables writes only with --execute', () => {
    const dry = parseTextOnlyBackfillArgs(REQUIRED_ARGS)
    expect(dry.execute).toBe(false)
    expect(dry.maxBatches).toBe(1)
    const run = parseTextOnlyBackfillArgs([...REQUIRED_ARGS, '--execute', '--batch-size', '50'])
    expect(run.execute).toBe(true)
    expect(run.maxBatches).toBeUndefined()
    expect(run.batchSize).toBe(50)
  })

  it('rejects an after-key that is not <accountId>:<tweetId>', () => {
    expect(() => parseTextOnlyBackfillArgs([...REQUIRED_ARGS, '--after-key', '--execute'])).toThrow(
      '--after-key must be <accountId>:<tweetId>',
    )
    expect(() => parseTextOnlyBackfillArgs([...REQUIRED_ARGS, '--after-key', '123'])).toThrow(
      '--after-key must be <accountId>:<tweetId>',
    )
    expect(parseTextOnlyBackfillArgs([...REQUIRED_ARGS, '--after-key', '7:123']).after).toEqual({
      accountId: '7',
      id: '123',
    })
  })

  it('rejects a non-positive batch size', () => {
    expect(() => parseTextOnlyBackfillArgs([...REQUIRED_ARGS, '--batch-size', '0'])).toThrow(
      '--batch-size must be a positive integer',
    )
  })
})

describe('runTextOnlyMediaBackfill', () => {
  it('does not write in dry-run and reports the candidates found in the sampled window', async () => {
    const { prisma, executeRaw, queryRaw } = makePrisma([['1', '2', '3']], [])
    queryRaw.mockReset()
    queryRaw.mockResolvedValueOnce([key('1'), key('2'), key('3')])
    queryRaw.mockResolvedValueOnce([{ count: 2n }])
    const deps = makeDeps(prisma)

    await runTextOnlyMediaBackfill(parseTextOnlyBackfillArgs(REQUIRED_ARGS), deps)

    expect(executeRaw).not.toHaveBeenCalled()
    expect(JSON.parse(deps.logs.at(-1) ?? '{}')).toMatchObject({
      mode: 'dry-run',
      scanned: 3,
      candidates: 2,
      lastKey: 'a3:3',
    })
  })

  it('updates windows until the id scan is exhausted and sleeps between batches', async () => {
    const { prisma, executeRaw } = makePrisma([['1', '2'], ['3']], [2, 1])
    const deps = makeDeps(prisma)

    await runTextOnlyMediaBackfill(
      parseTextOnlyBackfillArgs([...REQUIRED_ARGS, '--execute', '--sleep-ms', '5']),
      deps,
    )

    expect(executeRaw).toHaveBeenCalledTimes(2)
    expect(deps.sleep).toHaveBeenCalledWith(5)
    expect(JSON.parse(deps.logs.at(-1) ?? '{}')).toMatchObject({
      mode: 'execute',
      scanned: 3,
      updated: 3,
      lastKey: 'a3:3',
    })
  })

  it('stops after --max-batches windows even when more ids remain', async () => {
    const { prisma, executeRaw } = makePrisma([['1'], ['2'], ['3']], [1, 1, 1])
    const deps = makeDeps(prisma)

    await runTextOnlyMediaBackfill(
      parseTextOnlyBackfillArgs([...REQUIRED_ARGS, '--execute', '--max-batches', '2']),
      deps,
    )

    expect(executeRaw).toHaveBeenCalledTimes(2)
    expect(JSON.parse(deps.logs.at(-1) ?? '{}')).toMatchObject({ lastKey: 'a2:2', updated: 2 })
  })
})
