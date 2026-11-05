import { beforeEach, describe, expect, it } from 'vitest'
import { createSyntheticId } from 'id-boundary'
import type { PrismaClient } from '../generated/prisma'
import type { LabelRule, LabelRuleResult } from '../labels/types'
import { getPrismaClient } from './client'
import { getOrThrow } from './label-test-support'
import {
  ensureLabelDefinitionsForRules,
  recordAccountLabelsBulkForAccounts,
  recordCrawlAccountLabelsAtomic,
  recordCrawlAccountLabelsAtomicWithinTx,
} from './label-repository'

// 乱数の ID は衝突しうるため、基点からの連番で一意にする。
const ID_BASE = BigInt(createSyntheticId())
let idCounter = 0n
function newId(): string {
  idCounter += 1n
  return String(ID_BASE + idCounter)
}

function makeRule(key: string, version = 'v1'): LabelRule {
  return {
    key,
    description: `${key} description`,
    version,
    evaluate: () => ({ value: false, confidence: 1, reason: 'unused' }),
  }
}

function result(value: boolean, confidence: number, reason: string): LabelRuleResult {
  return { value, confidence, reason }
}

interface SnapshotEntry {
  labelDefinitionId: number
  value: boolean
  confidence: number
  reason: string
  method: string
  ruleVersion: string
  evaluable: boolean
  labeledAt: string
}

/** 指定した application_name の transaction が Postgres の lock wait に入るまで待つ。 */
async function waitForSessionToWaitOnLock(
  prisma: PrismaClient,
  applicationName: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await prisma.$queryRaw<{ waiting: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE application_name = ${applicationName} AND wait_event_type = 'Lock'
      ) AS "waiting"
    `
    if (rows[0]?.waiting) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for Postgres lock wait: ${applicationName}`)
}

// node:crypto の randomUUID は、実 DB を使うこのファイルではモックしない。
describe.skipIf(!process.env.DATABASE_URL)('recordCrawlAccountLabelsAtomic', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.analysisWorkItem.deleteMany()
    await prisma.accountClassificationObservation.deleteMany()
    await prisma.crawlAccountLabelRun.deleteMany()
    await prisma.crawlAuthorCheckpoint.deleteMany()
    await prisma.crawlRun.deleteMany()
    await prisma.$executeRawUnsafe(
      'TRUNCATE "AccountActiveLabel", "AccountLabelState", "AccountLabelChange", "LabelRuleVersion", "LabelDefinition" RESTART IDENTITY CASCADE',
    )
    // 他の integration test / benchmark が同じ DB に Block/Tweet/Follow を残していると、
    // account の外部キー制約により削除が失敗するため先に消しておく。
    await prisma.block.deleteMany()
    await prisma.tweet.deleteMany()
    await prisma.follow.deleteMany()
    await prisma.account.deleteMany()
  })

  async function createAccount(): Promise<string> {
    const id = newId()
    await prisma.account.create({
      data: {
        id,
        screenName: `synthetic_${id}`,
        displayName: 'Synthetic account',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    return id
  }

  async function createCrawlRun(): Promise<string> {
    const crawlRun = await prisma.crawlRun.create({
      data: { startedAt: new Date(), lastHeartbeatAt: new Date(), status: 'running' },
    })
    return crawlRun.id
  }

  async function snapshotOf(observationId: string | null): Promise<SnapshotEntry[]> {
    const observation = await prisma.accountClassificationObservation.findUniqueOrThrow({
      where: { id: observationId ?? '' },
    })
    return observation.classificationSnapshot as unknown as SnapshotEntry[]
  }

  it('creates one AccountClassificationObservation and enqueues account_summary_refresh in the same transaction when at least one claim succeeds', async () => {
    const accountId = await createAccount()
    const ids = await ensureLabelDefinitionsForRules(prisma, [makeRule('test_label')])
    const crawlRunId = await createCrawlRun()

    const observationId = await recordCrawlAccountLabelsAtomic(prisma, {
      accountId,
      crawlRunId,
      username: 'login_account',
      labels: [
        {
          labelDefinitionId: getOrThrow(ids, 'test_label'),
          result: result(true, 0.9, 'test reason'),
          method: 'rule',
          ruleVersion: 'v1',
        },
      ],
    })

    expect(observationId).not.toBeNull()
    const observation = await prisma.accountClassificationObservation.findUnique({
      where: { id: observationId ?? '' },
    })
    expect(observation?.accountId).toBe(accountId)
    expect(observation?.labelCount).toBe(1)
    const active = await prisma.accountActiveLabel.findFirstOrThrow({ where: { accountId } })
    expect(active.sourceKind).toBe(1)
    expect(active.sourceId).toBe(crawlRunId)
    expect(active.sourceUsername).toBe('login_account')
    const workItem = await prisma.analysisWorkItem.findFirst({
      where: {
        kind: 'account_summary_refresh',
        triggerType: 'account_classification_observation',
        triggerId: observationId ?? '',
      },
    })
    expect(workItem).not.toBeNull()
  })

  it('returns null, creates no observation, and enqueues nothing when all rule claims were already recorded (resume)', async () => {
    const accountId = await createAccount()
    const ids = await ensureLabelDefinitionsForRules(prisma, [makeRule('test_label_2')])
    const crawlRunId = await createCrawlRun()
    const params = {
      accountId,
      crawlRunId,
      username: 'login_account',
      labels: [
        {
          labelDefinitionId: getOrThrow(ids, 'test_label_2'),
          result: result(false, 0.1, 'test reason'),
          method: 'rule',
          ruleVersion: 'v1',
        },
      ],
    }

    expect(await recordCrawlAccountLabelsAtomic(prisma, params)).not.toBeNull()
    expect(await recordCrawlAccountLabelsAtomic(prisma, params)).toBeNull()

    expect(
      await prisma.analysisWorkItem.count({ where: { kind: 'account_summary_refresh' } }),
    ).toBe(1)
  })

  it('stores a classificationSnapshot synthesized from the true rows and the state (true, false and unevaluable)', async () => {
    const accountId = await createAccount()
    const ids = await ensureLabelDefinitionsForRules(prisma, [
      makeRule('snapshot_true'),
      makeRule('snapshot_false'),
      makeRule('snapshot_unevaluable'),
    ])
    const crawlRunId = await createCrawlRun()

    const observationId = await recordCrawlAccountLabelsAtomic(prisma, {
      accountId,
      crawlRunId,
      username: 'login_account',
      labels: [
        {
          labelDefinitionId: getOrThrow(ids, 'snapshot_true'),
          result: result(true, 0.9, 'reason true'),
          method: 'snapshot_true',
          ruleVersion: 'v1',
        },
        {
          labelDefinitionId: getOrThrow(ids, 'snapshot_false'),
          result: result(false, 0.1, 'reason false'),
          method: 'snapshot_false',
          ruleVersion: 'v1',
        },
        {
          labelDefinitionId: getOrThrow(ids, 'snapshot_unevaluable'),
          result: { value: false, confidence: 0.5, reason: 'reason unevaluable', evaluable: false },
          method: 'snapshot_unevaluable',
          ruleVersion: 'v1',
        },
      ],
    })

    const observation = await prisma.accountClassificationObservation.findUniqueOrThrow({
      where: { id: observationId ?? '' },
    })
    expect(observation.snapshotVersion).toBe(1)
    const state = await prisma.accountLabelState.findUniqueOrThrow({ where: { accountId } })
    const activeRow = await prisma.accountActiveLabel.findFirstOrThrow({ where: { accountId } })
    const snapshot = await snapshotOf(observationId)
    const byLabel = new Map(snapshot.map((entry) => [entry.labelDefinitionId, entry]))
    expect(snapshot.map((entry) => entry.labelDefinitionId)).toEqual(
      [...ids.values()].toSorted((left, right) => left - right),
    )
    expect(byLabel.get(getOrThrow(ids, 'snapshot_true'))).toEqual({
      labelDefinitionId: ids.get('snapshot_true'),
      value: true,
      confidence: 0.9,
      reason: 'reason true',
      method: 'snapshot_true',
      ruleVersion: 'v1',
      evaluable: true,
      labeledAt: activeRow.labeledAt.toISOString(),
    })
    expect(byLabel.get(getOrThrow(ids, 'snapshot_false'))).toEqual({
      labelDefinitionId: ids.get('snapshot_false'),
      value: false,
      confidence: 0.1,
      reason: 'reason false',
      method: 'snapshot_false',
      ruleVersion: 'v1',
      evaluable: true,
      labeledAt: state.evaluatedAt.toISOString(),
    })
    expect(byLabel.get(getOrThrow(ids, 'snapshot_unevaluable'))).toEqual({
      labelDefinitionId: ids.get('snapshot_unevaluable'),
      value: false,
      confidence: 0.5,
      reason: 'reason unevaluable',
      method: 'snapshot_unevaluable',
      ruleVersion: 'v1',
      evaluable: false,
      labeledAt: state.evaluatedAt.toISOString(),
    })
  })

  it('records a true label that became unevaluable as an unevaluable change and keeps no true row', async () => {
    const accountId = await createAccount()
    const ids = await ensureLabelDefinitionsForRules(prisma, [makeRule('flip')])
    const labelDefinitionId = getOrThrow(ids, 'flip')
    const first = await createCrawlRun()
    const second = await createCrawlRun()
    const labelWith = (labelResult: LabelRuleResult) => [
      { labelDefinitionId, result: labelResult, method: 'flip', ruleVersion: 'v1' },
    ]

    await recordCrawlAccountLabelsAtomic(prisma, {
      accountId,
      crawlRunId: first,
      username: 'login_account',
      labels: labelWith(result(true, 0.9, 'was true')),
    })
    const observationId = await recordCrawlAccountLabelsAtomic(prisma, {
      accountId,
      crawlRunId: second,
      username: 'login_account',
      labels: labelWith({ value: false, confidence: 0.5, reason: 'no samples', evaluable: false }),
    })

    expect(await prisma.accountActiveLabel.count({ where: { accountId } })).toBe(0)
    const changes = await prisma.accountLabelChange.findMany({
      where: { accountId },
      orderBy: { id: 'asc' },
    })
    expect(changes.map((row) => [row.changeType, row.sourceId])).toEqual([
      ['added', first],
      ['unevaluable', second],
    ])
    const [unevaluableEntry] = await snapshotOf(observationId)
    expect(unevaluableEntry).toMatchObject({
      value: false,
      evaluable: false,
      reason: 'no samples',
    })
  })

  it('同一crawlRunIdの部分的な再開呼び出しでも、前回claim済みのラベルを永続化済みの状態から補いsnapshotに含める', async () => {
    const accountId = await createAccount()
    const ids = await ensureLabelDefinitionsForRules(prisma, [
      makeRule('partial_a'),
      makeRule('partial_b'),
    ])
    const crawlRunId = await createCrawlRun()
    const labelA = {
      labelDefinitionId: getOrThrow(ids, 'partial_a'),
      result: result(true, 0.9, 'reason a'),
      method: 'rule',
      ruleVersion: 'v1',
    }
    const labelB = {
      labelDefinitionId: getOrThrow(ids, 'partial_b'),
      result: result(true, 0.8, 'reason b'),
      method: 'rule',
      ruleVersion: 'v1',
    }

    // 1 回目は labelA のみ claim・記録する (labelB の評価前にプロセスが再起動した想定)。
    await recordCrawlAccountLabelsAtomic(prisma, {
      accountId,
      crawlRunId,
      username: 'login_account',
      labels: [labelA],
    })
    const resumedObservationId = await recordCrawlAccountLabelsAtomic(prisma, {
      accountId,
      crawlRunId,
      username: 'login_account',
      labels: [labelA, labelB],
    })

    const snapshot = await snapshotOf(resumedObservationId)
    expect(snapshot.map((entry) => [entry.labelDefinitionId, entry.value, entry.reason])).toEqual([
      [labelA.labelDefinitionId, true, 'reason a'],
      [labelB.labelDefinitionId, true, 'reason b'],
    ])
    const resumedObservation = await prisma.accountClassificationObservation.findUniqueOrThrow({
      where: { id: resumedObservationId ?? '' },
    })
    expect(resumedObservation.labelCount).toBe(1)
  })

  it('状態の添字が 0 のラベルが snapshot に残るときは、書き込みの不整合として例外にする', async () => {
    const accountId = await createAccount()
    const ids = await ensureLabelDefinitionsForRules(prisma, [
      makeRule('slot_a'),
      makeRule('slot_b'),
    ])
    const crawlRunId = await createCrawlRun()
    const labelB = {
      labelDefinitionId: getOrThrow(ids, 'slot_b'),
      result: result(true, 0.8, 'reason b'),
      method: 'rule',
      ruleVersion: 'v1',
    }
    await prisma.crawlAccountLabelRun.create({
      data: {
        crawlRunId,
        username: 'login_account',
        accountId,
        labelDefinitionId: labelB.labelDefinitionId,
        method: 'rule',
        ruleVersion: 'v1',
      },
    })

    await expect(
      recordCrawlAccountLabelsAtomic(prisma, {
        accountId,
        crawlRunId,
        username: 'login_account',
        labels: [
          {
            labelDefinitionId: getOrThrow(ids, 'slot_a'),
            result: result(true, 0.9, 'reason a'),
            method: 'rule',
            ruleVersion: 'v1',
          },
          labelB,
        ],
      }),
    ).rejects.toThrow(
      `recordCrawlAccountLabelsAtomicWithinTx: label slot is 0 after persistence (accountId=${accountId}, labelDefinitionId=${labelB.labelDefinitionId})`,
    )
    expect(await prisma.accountLabelState.count({ where: { accountId } })).toBe(0)
  })

  it('crawl が rev を読んだ後に別の writer が commit した場合、rev を読み直して書き直し、新しい評価を反映する', async () => {
    const accountId = await createAccount()
    const ids = await ensureLabelDefinitionsForRules(prisma, [makeRule('race')])
    const labelDefinitionId = getOrThrow(ids, 'race')
    const crawlRunId = await createCrawlRun()

    let releaseRelabel!: () => void
    const relabelMayCommit = new Promise<void>((resolve) => {
      releaseRelabel = resolve
    })
    let relabelLocked!: () => void
    const relabelHoldsLock = new Promise<void>((resolve) => {
      relabelLocked = resolve
    })
    const relabel = prisma.$transaction(async (tx) => {
      await recordAccountLabelsBulkForAccounts(tx, {
        labels: [
          {
            accountId,
            labelDefinitionId,
            result: result(false, 0.2, 'relabel false'),
            method: 'race',
            ruleVersion: 'v1',
          },
        ],
        expectedRevByAccountId: new Map([[accountId, 0]]),
        sourceKind: 'relabel',
        sourceId: 'relabel-run',
      })
      relabelLocked()
      await relabelMayCommit
    })
    await relabelHoldsLock

    const applicationName = 'tac_crawl_cas_retry'
    const crawl = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL application_name = '${applicationName}'`)
      return recordCrawlAccountLabelsAtomicWithinTx(tx as unknown as PrismaClient, {
        accountId,
        crawlRunId,
        username: 'login_account',
        labels: [
          {
            labelDefinitionId,
            result: result(true, 0.95, 'crawl true'),
            method: 'race',
            ruleVersion: 'v1',
          },
        ],
      })
    })
    await waitForSessionToWaitOnLock(prisma, applicationName)
    releaseRelabel()
    const [observationId] = await Promise.all([crawl, relabel])

    const state = await prisma.accountLabelState.findUniqueOrThrow({ where: { accountId } })
    expect(state.rev).toBe(2)
    const active = await prisma.accountActiveLabel.findFirstOrThrow({ where: { accountId } })
    expect(active.sourceId).toBe(crawlRunId)
    const [crawlEntry] = await snapshotOf(observationId)
    expect(crawlEntry).toMatchObject({
      value: true,
      confidence: 0.95,
      reason: 'crawl true',
    })
  }, 15_000)
})
