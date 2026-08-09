import { describe, expect, it, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { selectBlockCandidates } from './candidate-repository'
import { getPrismaClient } from './client'

function fakePrismaReturning(rows: unknown[]) {
  return {
    $queryRaw: vi.fn().mockImplementation((strings: readonly string[]) => {
      const sql = strings.join('')
      expect(sql).toContain('DISTINCT ON')
      return Promise.resolve(rows)
    }),
  }
}

describe('selectBlockCandidates', () => {
  it('returns rows ordered by confidence desc, capped at maxCount', async () => {
    const prisma = fakePrismaReturning([
      { accountId: 'spam-1', labelDefinitionId: 'label-spam', confidence: 0.99 },
      { accountId: 'spam-2', labelDefinitionId: 'label-spam', confidence: 0.85 },
    ])

    const result = await selectBlockCandidates(
      prisma as never,
      'blocker-1',
      {
        targetLabels: [
          { label: 'spam', confidenceThreshold: 0.8 },
          { label: 'bot', confidenceThreshold: 0.8 },
        ],
      },
      50,
    )

    expect(result).toEqual([
      { accountId: 'spam-1', labelDefinitionId: 'label-spam', confidence: 0.99 },
      { accountId: 'spam-2', labelDefinitionId: 'label-spam', confidence: 0.85 },
    ])
  })

  it('passes each label with its own confidenceThreshold, blockerId and the cap as query parameters', async () => {
    const prisma = fakePrismaReturning([])

    await selectBlockCandidates(
      prisma as never,
      'blocker-1',
      {
        targetLabels: [
          { label: 'spam', confidenceThreshold: 0.9 },
          { label: 'bot', confidenceThreshold: 0.5 },
        ],
      },
      10,
    )

    const [, ...values] = prisma.$queryRaw.mock.calls[0]
    expect(values).toContain('blocker-1')
    expect(values).toEqual(expect.arrayContaining([['spam', 'bot'], [0.9, 0.5], 10]))
  })

  it('returns an empty array when no row satisfies the rule', async () => {
    const prisma = fakePrismaReturning([])

    const result = await selectBlockCandidates(
      prisma as never,
      'blocker-1',
      { targetLabels: [{ label: 'spam', confidenceThreshold: 0.9 }] },
      50,
    )

    expect(result).toEqual([])
  })
})

describe('selectBlockCandidates SQL shape', () => {
  it('excludes rows via NOT EXISTS against Block, BlockAction, and Follow', async () => {
    const prisma = fakePrismaReturning([])

    await selectBlockCandidates(
      prisma as never,
      'blocker-1',
      { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
      50,
    )

    const [strings] = prisma.$queryRaw.mock.calls[0]
    const sql = (strings as readonly string[]).join('')
    expect(sql).toContain('"Block"')
    expect(sql).toContain('"BlockAction"')
    expect(sql).toContain('"Follow"')
    expect(sql).toContain(`ba."result" = 'success'`)
  })

  it('未解決 outbox entry がある候補を BlockOutboxEntry への NOT EXISTS で除外する', async () => {
    const prisma = fakePrismaReturning([])

    await selectBlockCandidates(
      prisma as never,
      'blocker-1',
      { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
      50,
    )

    const [strings] = prisma.$queryRaw.mock.calls[0]
    const sql = (strings as readonly string[]).join('')
    expect(sql).toContain('"BlockOutboxEntry"')
    expect(sql).toContain(`oe."status" IN ('pending_remote', 'remote_succeeded')`)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('selectBlockCandidates (DB integration)', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.blockOutboxEntry.deleteMany()
    await prisma.blockAction.deleteMany()
    await prisma.blockAccountRun.deleteMany()
    await prisma.blockRun.deleteMany()
    await prisma.accountLabelLatest.deleteMany()
    await prisma.accountLabel.deleteMany()
    await prisma.account.deleteMany()
    await prisma.labelDefinition.deleteMany()
  })

  it('未解決 outbox entry がある候補を除外する', async () => {
    const blockerId = `blocker-${randomUUID()}`
    const blockedId = `blocked-${randomUUID()}`
    await prisma.account.create({
      data: {
        id: blockerId,
        screenName: 'alice',
        displayName: 'Alice',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    await prisma.account.create({
      data: {
        id: blockedId,
        screenName: 'bob',
        displayName: 'Bob',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: 'spam', description: '架空のテスト用ラベル' },
    })
    await prisma.accountLabel.create({
      data: {
        accountId: blockedId,
        labelDefinitionId: labelDefinition.id,
        value: true,
        confidence: 0.9,
        reason: 'test',
        method: 'rule',
        ruleVersion: 'v1',
      },
    })
    await prisma.accountLabelLatest.create({
      data: {
        accountId: blockedId,
        labelDefinitionId: labelDefinition.id,
        value: true,
        confidence: 0.9,
        reason: 'test',
        method: 'rule',
        ruleVersion: 'v1',
        labeledAt: new Date(),
      },
    })
    const blockRun = await prisma.blockRun.create({
      data: { startedAt: new Date(), lastHeartbeatAt: new Date(), status: 'running' },
    })
    const accountRun = await prisma.blockAccountRun.create({
      data: {
        blockRunId: blockRun.id,
        username: 'alice',
        startedAt: new Date(),
        status: 'running',
      },
    })
    await prisma.blockOutboxEntry.create({
      data: {
        blockAccountRunId: accountRun.id,
        blockerId,
        blockedId,
        labelDefinitionId: labelDefinition.id,
        confidence: 0.9,
        status: 'pending_remote',
      },
    })

    const candidates = await selectBlockCandidates(
      prisma,
      blockerId,
      { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
      10,
    )

    expect(candidates.map((candidate) => candidate.accountId)).not.toContain(blockedId)
  })
})
