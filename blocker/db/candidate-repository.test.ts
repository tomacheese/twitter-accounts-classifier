import { describe, expect, it, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { selectBlockCandidates } from './candidate-repository'
import { getPrismaClient } from './client'

function fakePrismaReturning(rows: unknown[]) {
  return {
    $queryRaw: vi.fn().mockResolvedValue(rows),
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
      3,
      21_600,
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
      3,
      21_600,
    )

    const [, ...values] = prisma.$queryRaw.mock.calls[0]
    expect(values).toContain('blocker-1')
    expect(values).toEqual(expect.arrayContaining([['spam', 'bot'], [0.9, 0.5], 10]))
  })

  it('filters non-blocking reply-farming labels out of the SQL parameters', async () => {
    const prisma = fakePrismaReturning([])

    await selectBlockCandidates(
      prisma as never,
      'blocker-1',
      {
        targetLabels: [
          { label: 'spam', confidenceThreshold: 0.8 },
          { label: 'reply_farming', confidenceThreshold: 0.5 },
          { label: 'generic_reply_farming', confidenceThreshold: 0.5 },
        ],
      },
      50,
      3,
      21_600,
    )

    const [, ...values] = prisma.$queryRaw.mock.calls[0]
    expect(values).toEqual(expect.arrayContaining([['spam'], [0.8]]))
    expect(values).not.toContainEqual(['reply_farming', 'generic_reply_farming'])
  })

  it('returns without querying when every configured target label is non-blocking', async () => {
    const prisma = fakePrismaReturning([])

    const result = await selectBlockCandidates(
      prisma as never,
      'blocker-1',
      {
        targetLabels: [
          { label: 'reply_farming', confidenceThreshold: 0.5 },
          { label: 'generic_reply_farming', confidenceThreshold: 0.5 },
        ],
      },
      50,
      3,
      21_600,
    )

    expect(result).toEqual([])
    expect(prisma.$queryRaw).not.toHaveBeenCalled()
  })

  it('returns an empty array when no row satisfies the rule', async () => {
    const prisma = fakePrismaReturning([])

    const result = await selectBlockCandidates(
      prisma as never,
      'blocker-1',
      { targetLabels: [{ label: 'spam', confidenceThreshold: 0.9 }] },
      50,
      3,
      21_600,
    )

    expect(result).toEqual([])
  })
})

describe('selectBlockCandidates SQL shape', () => {
  it('uses AccountLabelLatest confidence without scanning AccountLabel history', async () => {
    const prisma = fakePrismaReturning([])

    await selectBlockCandidates(
      prisma as never,
      'blocker-1',
      { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
      50,
      3,
      21_600,
    )

    const [strings] = prisma.$queryRaw.mock.calls[0]
    const sql = (strings as readonly string[]).join('')
    expect(sql).toContain('all_latest."confidence"')
    expect(sql).not.toContain('FROM "AccountLabel"')
  })

  it('excludes rows via NOT EXISTS against Block, BlockAction, and Follow', async () => {
    const prisma = fakePrismaReturning([])

    await selectBlockCandidates(
      prisma as never,
      'blocker-1',
      { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
      50,
      3,
      21_600,
    )

    const [strings] = prisma.$queryRaw.mock.calls[0]
    const sql = (strings as readonly string[]).join('')
    expect(sql).toContain('"Block"')
    expect(sql).toContain('"BlockAction"')
    expect(sql).toContain('"Follow"')
    expect(sql).toContain(`ba."result" = 'success'`)
  })

  it('requires AccountLabelLatest.ruleVersion to match LabelDefinition.currentRuleVersion', async () => {
    const prisma = fakePrismaReturning([])

    await selectBlockCandidates(
      prisma as never,
      'blocker-1',
      { targetLabels: [{ label: 'bot', confidenceThreshold: 0.5 }] },
      50,
      3,
      21_600,
    )

    const [strings] = prisma.$queryRaw.mock.calls[0]
    const sql = (strings as readonly string[]).join('')
    expect(sql).toContain('"ruleVersion" = rl."currentRuleVersion"')
  })

  it('未解決 outbox entry がある候補を BlockOutboxEntry への NOT EXISTS で除外する', async () => {
    const prisma = fakePrismaReturning([])

    await selectBlockCandidates(
      prisma as never,
      'blocker-1',
      { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
      50,
      3,
      21_600,
    )

    const [strings] = prisma.$queryRaw.mock.calls[0]
    const sql = (strings as readonly string[]).join('')
    expect(sql).toContain('"BlockOutboxEntry"')
    expect(sql).toContain(`oe."status" IN ('pending_remote', 'remote_succeeded')`)
  })

  it('remote_skipped の terminal skip / cooldown 条件を BlockOutboxEntry への NOT EXISTS に含める', async () => {
    const prisma = fakePrismaReturning([])

    await selectBlockCandidates(
      prisma as never,
      'blocker-1',
      { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
      50,
      3,
      21_600,
    )

    const [strings, ...values] = prisma.$queryRaw.mock.calls[0]
    const sql = (strings as readonly string[]).join('')
    expect(sql).toContain(`oe."status" = 'remote_skipped'`)
    expect(sql).toContain('oe."remoteSkipCount"')
    expect(sql).toContain('oe."lastRemoteSkippedAt"')
    expect(values.at(-3)).toBe(3)
    expect(values.at(-2)).toBe(21_600)
    expect(values.at(-1)).toBe(50)
  })
})

describe('AccountLabelLatest_block_candidate_idx migration', () => {
  // tsconfig の module は CommonJS のため import.meta は使えない。
  // eslint-disable-next-line unicorn/prefer-module
  const migrationsDir = path.join(__dirname, '../../prisma/migrations')
  const dirs = readdirSync(migrationsDir).filter((d) =>
    d.includes('add_account_label_latest_block_candidate_index'),
  )
  const sql = readFileSync(path.join(migrationsDir, dirs[0], 'migration.sql'), 'utf8')

  it('該当 migration がちょうど1件存在する', () => {
    expect(dirs.length).toBe(1)
  })

  it('CREATE INDEX CONCURRENTLY で非トランザクション実行できる形にする', () => {
    expect(sql).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS')
  })

  it('label ごとの confidence 降順 Index Cond を成立させる列順にする', () => {
    expect(sql).toContain('("labelDefinitionId", "ruleVersion", "confidence" DESC, "accountId")')
  })

  it('value = true の部分 index にする', () => {
    expect(sql).toContain('WHERE "value" = true')
  })
})

describe.skipIf(!process.env.DATABASE_URL)('selectBlockCandidates (DB integration)', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.blockOutboxEntry.deleteMany()
    await prisma.blockAction.deleteMany()
    await prisma.block.deleteMany()
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
      3,
      21_600,
    )

    expect(candidates.map((candidate) => candidate.accountId)).not.toContain(blockedId)
  })

  it('remoteSkipCount が上限未満でも cooldown 中なら候補から除外する', async () => {
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
        status: 'remote_skipped',
        remoteSkipCount: 1,
        lastRemoteSkippedAt: new Date(),
      },
    })

    const candidates = await selectBlockCandidates(
      prisma,
      blockerId,
      { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
      10,
      3,
      21_600,
    )

    expect(candidates.map((candidate) => candidate.accountId)).not.toContain(blockedId)
  })

  it('remoteSkipCount が上限未満で cooldown 経過後なら候補になる', async () => {
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
      data: { key: 'spam', description: '架空のテスト用ラベル', currentRuleVersion: 'v1' },
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
        status: 'remote_skipped',
        remoteSkipCount: 1,
        lastRemoteSkippedAt: new Date(Date.now() - 22_000 * 1000),
      },
    })

    const candidates = await selectBlockCandidates(
      prisma,
      blockerId,
      { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
      10,
      3,
      21_600,
    )

    expect(candidates.map((candidate) => candidate.accountId)).toContain(blockedId)
  })

  it('remoteSkipCount が上限以上なら cooldown に関わらず候補から除外する', async () => {
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
        status: 'remote_skipped',
        remoteSkipCount: 3,
        lastRemoteSkippedAt: new Date(Date.now() - 22_000 * 1000),
      },
    })

    const candidates = await selectBlockCandidates(
      prisma,
      blockerId,
      { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
      10,
      3,
      21_600,
    )

    expect(candidates.map((candidate) => candidate.accountId)).not.toContain(blockedId)
  })

  it('remote_failed の target は remoteSkipCount / cooldown 条件と無関係に候補になり得る', async () => {
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
      data: { key: 'spam', description: '架空のテスト用ラベル', currentRuleVersion: 'v1' },
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
        status: 'remote_failed',
        // remote_skipped であれば terminal skip / cooldown 中になるはずの値をあえて設定し、
        // status の絞り込みが正しく remote_skipped 限定になっていることを検証する。
        remoteSkipCount: 3,
        lastRemoteSkippedAt: new Date(),
      },
    })

    const candidates = await selectBlockCandidates(
      prisma,
      blockerId,
      { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
      10,
      3,
      21_600,
    )

    expect(candidates.map((candidate) => candidate.accountId)).toContain(blockedId)
  })

  it('confidence 上位側が Block 済みで除外されても、maxCount まで下位の適格候補で補充する', async () => {
    const blockerId = `blocker-${randomUUID()}`
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
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: 'spam', description: '架空のテスト用ラベル', currentRuleVersion: 'v1' },
    })

    // confidence 降順に 5 件の適格候補を用意し、上位 2 件 (最も confidence が高い) を
    // Block 済みにする。per-label 固定 LIMIT で先頭側だけを取得する実装だと、
    // Block 済みの 2 件が枠を占有したまま補充されず false negative になる。
    const confidences = [0.95, 0.93, 0.91, 0.89, 0.87]
    const targetIds = confidences.map((_, index) => `target-${index}-${randomUUID()}`)
    for (const [index, confidence] of confidences.entries()) {
      await prisma.account.create({
        data: {
          id: targetIds[index],
          screenName: `target${index}`,
          displayName: `Target ${index}`,
          followersCount: 0,
          followingCount: 0,
          tweetCount: 0,
          accountCreatedAt: new Date(),
        },
      })
      await prisma.accountLabelLatest.create({
        data: {
          accountId: targetIds[index],
          labelDefinitionId: labelDefinition.id,
          value: true,
          confidence,
          reason: 'test',
          method: 'rule',
          ruleVersion: 'v1',
          labeledAt: new Date(),
        },
      })
    }
    await prisma.block.create({
      data: { blockerId, blockedId: targetIds[0] },
    })
    await prisma.block.create({
      data: { blockerId, blockedId: targetIds[1] },
    })

    const candidates = await selectBlockCandidates(
      prisma,
      blockerId,
      { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
      3,
      3,
      21_600,
    )

    expect(candidates.map((candidate) => candidate.accountId)).toEqual([
      targetIds[2],
      targetIds[3],
      targetIds[4],
    ])
  })
})
