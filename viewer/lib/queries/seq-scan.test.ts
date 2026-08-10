import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPrismaClient } from '../prisma'

const prisma = getPrismaClient()

interface ExplainPlanNode {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
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
  const childResults = (node.Plans ?? []).flatMap((child) => collectSeqScans(child, targetTable))
  return [...found, ...childResults]
}

/**
 * @param node - 探索対象のプランノード
 * @returns Sort / Incremental Sort ノードの一覧
 */
function collectSorts(node: ExplainPlanNode): ExplainPlanNode[] {
  const found =
    node['Node Type'] === 'Sort' || node['Node Type'] === 'Incremental Sort' ? [node] : []
  return [...found, ...(node.Plans ?? []).flatMap((child) => collectSorts(child))]
}

/**
 * @param node - 探索対象のプランノード
 * @param indexName - 検知対象の index 名
 * @returns 指定した index を使っているノード (Index Scan 系) の一覧
 */
function collectIndexUsages(node: ExplainPlanNode, indexName: string): ExplainPlanNode[] {
  const found = node['Index Name'] === indexName ? [node] : []
  return [...found, ...(node.Plans ?? []).flatMap((child) => collectIndexUsages(child, indexName))]
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

// listAccountSummaries・listLabelSummaries は generationId で絞り込む。
// 過去 generation の残骸行が同居していないと絞り込みの選択性が働かず、
// planner が Seq Scan を避けているかを検証できない。
const ROWS_PER_GENERATION = 300
const STALE_GENERATION_COUNT = 3

// 実際のプランを見るには稼働中の Postgres が要る。
// CI の既定ジョブには postgres サービスが無いため、接続先が無ければ skip する。
describe.skipIf(!process.env.DATABASE_URL)(
  'Seq Scan detection (representative read-model queries)',
  () => {
    const generationId = `seq-scan-test-${randomUUID()}`
    const staleGenerationIds = Array.from(
      { length: STALE_GENERATION_COUNT },
      () => `seq-scan-test-stale-${randomUUID()}`,
    )
    const allGenerationIds = [generationId, ...staleGenerationIds]

    beforeAll(async () => {
      await prisma.accountSummaryLatest.createMany({
        data: Array.from({ length: ROWS_PER_GENERATION }, (_, index) => ({
          accountId: `account-seq-scan-test-${index}`,
          normalizedScreenName: `screen_seq_${index}`,
          normalizedDisplayName: `Display ${index}`,
          searchDocument: `screen_seq_${index} display ${index}`,
          profileObservedAt: new Date(),
          activeLabelKeys: [],
          activeLabelCount: 0,
          activeFindingCount: 0,
          updatedAt: new Date(),
        })),
      })
      await prisma.$executeRawUnsafe('ANALYZE "AccountSummaryLatest"')

      for (const gid of allGenerationIds) {
        await prisma.accountSummaryCurrent.createMany({
          data: Array.from({ length: ROWS_PER_GENERATION }, (_, index) => ({
            generationId: gid,
            accountId: `account-${gid}-${index}`,
            normalizedScreenName: `screen_${gid}_${index}`,
            normalizedDisplayName: `Display ${index}`,
            searchDocument: `screen_${gid}_${index} display ${index}`,
            activeLabelKeys: [],
            activeLabelCount: 0,
            lastClassificationChangedAt: new Date(Date.now() - index * 60_000),
            activeFindingCount: 0,
            sourceWatermarkAt: new Date(),
          })),
        })
        await prisma.labelSummaryCurrent.createMany({
          data: Array.from({ length: ROWS_PER_GENERATION }, (_, index) => ({
            generationId: gid,
            labelDefinitionId: `label-${gid}-${index}`,
            evaluatedCount: 100,
            trueCount: 10,
            populationCount: 100,
            coverage: 1,
            prevalence: 0.1,
            activeFindingCount: 0,
            qualityStatus: 'stable',
            sourceWatermarkAt: new Date(),
          })),
        })
      }
      // 直近で挿入した行数を統計情報へ反映させないと、
      // planner が古い統計のまま Seq Scan を選び、実運用と乖離した結果になる。
      await prisma.$executeRawUnsafe('ANALYZE "AccountSummaryCurrent"')
      await prisma.$executeRawUnsafe('ANALYZE "LabelSummaryCurrent"')
    })

    afterAll(async () => {
      await prisma.accountSummaryCurrent.deleteMany({
        where: { generationId: { in: allGenerationIds } },
      })
      await prisma.labelSummaryCurrent.deleteMany({
        where: { generationId: { in: allGenerationIds } },
      })
      await prisma.accountSummaryLatest.deleteMany({
        where: { accountId: { startsWith: 'account-seq-scan-test-' } },
      })
    })

    it('listAccountSummaries (view: recentlyChanged) は AccountSummaryCurrent の Seq Scan を行わない', async () => {
      const plan = await explain(`
      SELECT "accountId" FROM "AccountSummaryCurrent"
      WHERE "generationId" = '${generationId}'
      ORDER BY "lastClassificationChangedAt" DESC NULLS LAST, "accountId" DESC
      LIMIT 25
    `)

      expect(collectSeqScans(plan, 'AccountSummaryCurrent')).toEqual([])
      expect(collectSorts(plan)).toEqual([])
    })

    it('listLabelSummaries は LabelSummaryCurrent の Seq Scan を行わない', async () => {
      const plan = await explain(`
      SELECT "labelDefinitionId" FROM "LabelSummaryCurrent"
      WHERE "generationId" = '${generationId}'
    `)

      expect(collectSeqScans(plan, 'LabelSummaryCurrent')).toEqual([])
    })

    it('searchAccounts (accountId exact) は AccountSummaryLatest の Seq Scan を行わない', async () => {
      const plan = await explain(`
        SELECT "accountId" FROM "AccountSummaryLatest" WHERE "accountId" = 'account-seq-scan-test-0'
      `)
      expect(collectSeqScans(plan, 'AccountSummaryLatest')).toEqual([])
    })

    it('searchAccounts (screen name prefix range) は AccountSummaryLatest の Seq Scan を行わない', async () => {
      const plan = await explain(`
        SELECT "accountId" FROM "AccountSummaryLatest"
        WHERE "normalizedScreenName" >= 'screen_seq' AND "normalizedScreenName" < 'screen_seq￿'
        ORDER BY "normalizedScreenName" ASC, "accountId" ASC
      `)
      expect(collectSeqScans(plan, 'AccountSummaryLatest')).toEqual([])
    })

    it('searchAccounts (display name contains) は AccountSummaryLatest の Seq Scan を行わない', async () => {
      const plan = await explain(`
        SELECT "accountId" FROM "AccountSummaryLatest"
        WHERE "normalizedDisplayName" ILIKE '%display 42%'
      `)
      expect(collectSeqScans(plan, 'AccountSummaryLatest')).toEqual([])
    })
  },
)

// activeLabelKeys の GIN index は、テーブルが小さいと planner が Seq Scan の方を安く見積もるため使われない。
// production 相当の選択性差を再現するには他の describe ブロックの行数よりずっと多い行数が要るため、別の describe ブロックへ分離し、他のテストのテーブル統計量を汚染しないようにする。
const LABEL_FILTER_ROW_COUNT = 2000
const RARE_LABEL_COUNT = 3
const COMMON_LABEL_COUNT = 800

describe.skipIf(!process.env.DATABASE_URL)(
  'listAccountSummaries label filter (activeLabelKeys GIN index)',
  () => {
    beforeAll(async () => {
      await prisma.accountSummaryLatest.createMany({
        data: Array.from({ length: LABEL_FILTER_ROW_COUNT }, (_, index) => ({
          accountId: `account-label-filter-test-${index}`,
          normalizedScreenName: `screen_label_filter_${index}`,
          normalizedDisplayName: `Display ${index}`,
          searchDocument: `screen_label_filter_${index} display ${index}`,
          profileObservedAt: new Date(),
          activeLabelKeys:
            index < RARE_LABEL_COUNT
              ? ['rare-label-test']
              : index < RARE_LABEL_COUNT + COMMON_LABEL_COUNT
                ? ['common-label-test']
                : [],
          activeLabelCount: index < RARE_LABEL_COUNT + COMMON_LABEL_COUNT ? 1 : 0,
          activeFindingCount: 0,
          updatedAt: new Date(),
        })),
      })
      await prisma.$executeRawUnsafe('ANALYZE "AccountSummaryLatest"')
    })

    afterAll(async () => {
      await prisma.accountSummaryLatest.deleteMany({
        where: { accountId: { startsWith: 'account-label-filter-test-' } },
      })
    })

    it('rare label は Seq Scan を行わず GIN index を使う', async () => {
      const plan = await explain(`
        SELECT "accountId" FROM "AccountSummaryLatest"
        WHERE "activeLabelKeys" && ARRAY['rare-label-test']
        ORDER BY "normalizedScreenName" ASC, "accountId" ASC
        LIMIT 25
      `)

      expect(collectSeqScans(plan, 'AccountSummaryLatest')).toEqual([])
      expect(collectIndexUsages(plan, 'AccountSummaryLatest_activeLabelKeys_gin_idx')).not.toEqual(
        [],
      )
    })

    it('common label は Seq Scan を行わない', async () => {
      const plan = await explain(`
        SELECT "accountId" FROM "AccountSummaryLatest"
        WHERE "activeLabelKeys" && ARRAY['common-label-test']
        ORDER BY "normalizedScreenName" ASC, "accountId" ASC
        LIMIT 25
      `)

      expect(collectSeqScans(plan, 'AccountSummaryLatest')).toEqual([])
    })

    it('filter なし (view: all) は Seq Scan を行わない', async () => {
      const plan = await explain(`
        SELECT "accountId" FROM "AccountSummaryLatest"
        ORDER BY "normalizedScreenName" ASC, "accountId" ASC
        LIMIT 25
      `)

      expect(collectSeqScans(plan, 'AccountSummaryLatest')).toEqual([])
    })

    it('view: recentlyChanged では Seq Scan を行わない', async () => {
      const plan = await explain(`
        SELECT "accountId" FROM "AccountSummaryLatest"
        WHERE "activeLabelKeys" && ARRAY['rare-label-test']
        ORDER BY "lastClassificationChangedAt" DESC NULLS LAST, "accountId" DESC
        LIMIT 25
      `)

      expect(collectSeqScans(plan, 'AccountSummaryLatest')).toEqual([])
    })

    it('cursor pagination (2 ページ目) でも Seq Scan を行わない', async () => {
      const plan = await explain(`
        SELECT "accountId" FROM "AccountSummaryLatest"
        WHERE "activeLabelKeys" && ARRAY['rare-label-test']
          AND (
            "normalizedScreenName" > 'screen_label_filter_0'
            OR ("normalizedScreenName" = 'screen_label_filter_0' AND "accountId" > 'account-label-filter-test-0')
          )
        ORDER BY "normalizedScreenName" ASC, "accountId" ASC
        LIMIT 25
      `)

      expect(collectSeqScans(plan, 'AccountSummaryLatest')).toEqual([])
    })
  },
)
