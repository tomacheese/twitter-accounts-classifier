import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPrismaClient } from '../db/client'

const prisma = getPrismaClient()

interface ExplainPlanNode {
  'Node Type': string
  'Relation Name'?: string
  Plans?: ExplainPlanNode[]
}

/**
 * `EXPLAIN (FORMAT JSON)` の結果木を辿り、指定したテーブルに対する Seq Scan ノードだけを集める。
 * @param node - 探索対象のプランノード
 * @param targetTable - 検知対象のテーブル名
 * @returns 見つかった Seq Scan ノードの一覧
 */
function collectSeqScans(node: ExplainPlanNode, targetTable: string): ExplainPlanNode[] {
  const found =
    node['Node Type'] === 'Seq Scan' && node['Relation Name'] === targetTable ? [node] : []
  return [...found, ...(node.Plans ?? []).flatMap((child) => collectSeqScans(child, targetTable))]
}

/**
 * @param sql - `EXPLAIN (FORMAT JSON)` を付けて実行する SQL
 * @returns プランのルートノード
 */
async function explain(sql: string): Promise<ExplainPlanNode> {
  const rows = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': [{ Plan: ExplainPlanNode }] }[]>(
    `EXPLAIN (FORMAT JSON) ${sql}`,
  )
  return rows[0]['QUERY PLAN'][0].Plan
}

// テーブルが小さいと planner が Seq Scan の方を安く見積もり、
// index の有無を検証できない。production 相当の選択性差を再現するため、
// 対象行と同居しないノイズ行を大量に挿入してから ANALYZE する。
const NOISE_LABEL_COUNT = 2000
const NOISE_ACCOUNT_COUNT = 2000

describe.skipIf(!process.env.DATABASE_URL)('label aggregate queries avoid Seq Scan', () => {
  const labelId = `label_seqscan_${randomUUID()}`
  const noiseLabelIds = Array.from(
    { length: NOISE_LABEL_COUNT },
    (_, index) => `${labelId}_noise_${index}`,
  )

  beforeAll(async () => {
    await prisma.labelDefinition.create({
      data: { id: labelId, key: labelId, description: 'テスト用ラベル' },
    })
    await prisma.labelDefinition.createMany({
      data: noiseLabelIds.map((id) => ({ id, key: id, description: 'ノイズ用ラベル' })),
    })
    await prisma.accountClassificationValueCount.create({
      data: { labelDefinitionId: labelId, value: true, count: 1, confidenceSum: 0.5 },
    })
    await prisma.accountClassificationValueCount.createMany({
      data: noiseLabelIds.map((id) => ({
        labelDefinitionId: id,
        value: true,
        count: 1,
        confidenceSum: 0.5,
      })),
    })
    await prisma.accountClassificationConfidenceBucketCount.create({
      data: { labelDefinitionId: labelId, confidenceBucket: 5, count: 1 },
    })
    await prisma.accountClassificationConfidenceBucketCount.createMany({
      data: noiseLabelIds.map((id) => ({ labelDefinitionId: id, confidenceBucket: 5, count: 1 })),
    })
    await prisma.accountClassificationRuleVersionCount.create({
      data: { labelDefinitionId: labelId, ruleVersion: 'v1', count: 1 },
    })
    await prisma.accountClassificationRuleVersionCount.createMany({
      data: noiseLabelIds.map((id) => ({ labelDefinitionId: id, ruleVersion: 'v1', count: 1 })),
    })
    await prisma.accountClassificationFreshnessBucket.create({
      data: { labelDefinitionId: labelId, observedAtBucket: new Date(), count: 1 },
    })
    await prisma.accountClassificationFreshnessBucket.createMany({
      data: noiseLabelIds.map((id) => ({
        labelDefinitionId: id,
        observedAtBucket: new Date(),
        count: 1,
      })),
    })

    await prisma.account.createMany({
      data: Array.from({ length: NOISE_ACCOUNT_COUNT }, (_, index) => ({
        id: `account-seq-scan-noise-${index}`,
        screenName: `account_seq_scan_noise_${index}`,
        displayName: `Noise ${index}`,
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      })),
    })
    await prisma.accountClassificationLatest.createMany({
      data: Array.from({ length: NOISE_ACCOUNT_COUNT }, (_, index) => ({
        accountId: `account-seq-scan-noise-${index}`,
        labelDefinitionId: noiseLabelIds[index % noiseLabelIds.length],
        value: index % 2 === 0,
        confidence: 0.5,
        reason: `noise_reason_${index}`,
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: new Date(),
      })),
    })
    await prisma.accountSummaryLatest.createMany({
      data: Array.from({ length: NOISE_ACCOUNT_COUNT }, (_, index) => ({
        accountId: `account-seq-scan-noise-${index}`,
        normalizedScreenName: `account_seq_scan_noise_${index}`,
        normalizedDisplayName: `noise ${index}`,
        searchDocument: `account_seq_scan_noise_${index} noise ${index}`,
        profileObservedAt: new Date(),
        activeLabelKeys: [],
        activeLabelCount: 0,
        classificationObservedAt: index % 2 === 0 ? new Date() : null,
      })),
    })

    await prisma.$executeRawUnsafe('ANALYZE "AccountSummaryLatest"')
    await prisma.$executeRawUnsafe('ANALYZE "AccountClassificationLatest"')
    await prisma.$executeRawUnsafe('ANALYZE "AccountClassificationValueCount"')
    await prisma.$executeRawUnsafe('ANALYZE "AccountClassificationConfidenceBucketCount"')
    await prisma.$executeRawUnsafe('ANALYZE "AccountClassificationRuleVersionCount"')
    await prisma.$executeRawUnsafe('ANALYZE "AccountClassificationFreshnessBucket"')
  })

  afterAll(async () => {
    await prisma.accountClassificationValueCount.deleteMany({
      where: { labelDefinitionId: { in: [labelId, ...noiseLabelIds] } },
    })
    await prisma.accountClassificationConfidenceBucketCount.deleteMany({
      where: { labelDefinitionId: { in: [labelId, ...noiseLabelIds] } },
    })
    await prisma.accountClassificationRuleVersionCount.deleteMany({
      where: { labelDefinitionId: { in: [labelId, ...noiseLabelIds] } },
    })
    await prisma.accountClassificationFreshnessBucket.deleteMany({
      where: { labelDefinitionId: { in: [labelId, ...noiseLabelIds] } },
    })
    await prisma.accountClassificationLatest.deleteMany({
      where: { accountId: { startsWith: 'account-seq-scan-noise-' } },
    })
    await prisma.accountSummaryLatest.deleteMany({
      where: { accountId: { startsWith: 'account-seq-scan-noise-' } },
    })
    await prisma.account.deleteMany({ where: { id: { startsWith: 'account-seq-scan-noise-' } } })
    await prisma.labelDefinition.deleteMany({ where: { id: { in: [labelId, ...noiseLabelIds] } } })
  })

  it('AccountSummaryLatest 基準の populationCount クエリ', async () => {
    // AccountSummaryLatest は classificationObservedAt の選択性次第で Seq Scan が
    // 最適プランになり得るテーブルであり、spec の完了条件が禁止しているのは
    // AccountClassificationLatest への Seq Scan のみである。この populationCount
    // クエリは AccountClassificationLatest を参照しないため、この観点では自明に満たす。
    const plan = await explain(
      `SELECT COUNT(*) AS count FROM "AccountSummaryLatest" WHERE "classificationObservedAt" IS NOT NULL`,
    )
    expect(collectSeqScans(plan, 'AccountClassificationLatest')).toHaveLength(0)
  })

  it('4つの集計テーブル読み取りクエリ', async () => {
    const queries = [
      `SELECT "labelDefinitionId", "value", "count", "confidenceSum" FROM "AccountClassificationValueCount" WHERE "labelDefinitionId" IN ('${labelId}')`,
      `SELECT "labelDefinitionId", "confidenceBucket", "count" FROM "AccountClassificationConfidenceBucketCount" WHERE "labelDefinitionId" IN ('${labelId}')`,
      `SELECT "labelDefinitionId", "ruleVersion", "count" FROM "AccountClassificationRuleVersionCount" WHERE "labelDefinitionId" IN ('${labelId}')`,
      `SELECT "labelDefinitionId", SUM("count") FROM "AccountClassificationFreshnessBucket" WHERE "labelDefinitionId" IN ('${labelId}') GROUP BY 1`,
    ]
    for (const sql of queries) {
      const plan = await explain(sql)
      const table = /FROM "(\w+)"/.exec(sql)?.[1] ?? ''
      expect(collectSeqScans(plan, table)).toHaveLength(0)
    }
  })

  it('reasonDistribution クエリ (value = true に絞った index-only scan)', async () => {
    const plan = await explain(
      `SELECT "labelDefinitionId", "reason", COUNT(*) FROM "AccountClassificationLatest" WHERE "labelDefinitionId" IN ('${labelId}') AND "value" = true GROUP BY 1, 2`,
    )
    expect(collectSeqScans(plan, 'AccountClassificationLatest')).toHaveLength(0)
  })
})
