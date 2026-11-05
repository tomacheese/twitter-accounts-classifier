import { setTimeout as sleep } from 'node:timers/promises'
import { Logger } from '@book000/node-utils'
import { computeFingerprint } from '../findings/fingerprint'
import { Prisma, type PrismaClient } from '../generated/prisma'
import { MAINTENANCE_BATCH } from './config'

const logger = Logger.configure('analyzer:orphan-check')

/**
 * FK を張らない表のうち、Account.id を accountId で参照する表。
 * AccountCrawlState など FK を持つ表は DB が整合性を守るため含めない。
 */
export const ORPHAN_CHECK_TABLES = [
  'Tweet',
  'AccountLabelState',
  'AccountActiveLabel',
  'AccountLabelChange',
  'AccountClassificationLatest',
  'AccountClassificationObservation',
  'AccountSummaryLatest',
] as const

export type OrphanCheckTable = (typeof ORPHAN_CHECK_TABLES)[number]

const MIN_BIGINT = '-9223372036854775808'
const SAMPLE_SIZE = 20

export interface OrphanCheckOptions {
  /** 検査する表。既定は ORPHAN_CHECK_TABLES の全表。 */
  tables?: readonly OrphanCheckTable[]
  /** 表ごとの再開位置 (前回の nextCursor)。省略した表は先頭から検査する。 */
  resumeFrom?: Partial<Record<OrphanCheckTable, string>>
  /** 表ごとに読むバッチ数の上限。省略すると最後まで検査する。 */
  maxBatchesPerTable?: number
  batchSize?: number
  pauseMs?: number
}

export interface OrphanCheckTableResult {
  table: OrphanCheckTable
  scannedRows: number
  /** Account に存在しない accountId の数。 */
  orphanAccountCount: number
  /** 孤児の accountId を持つ行数。 */
  orphanRowCount: number
  sampleAccountIds: string[]
  /** 上限で打ち切ったときの再開位置。最後まで検査したときは null。 */
  nextCursor: string | null
}

interface PageRow {
  lastAccountId: string | null
  scannedRows: number
  orphanIds: string[]
}

/**
 * accountId の昇順に、1 文あたり batchSize 行までを読んで Account の存在を確かめる。
 * 読み取りだけで、索引の範囲走査と Account の主キー参照で進むため、表全体を 1 文で走査しない。
 */
async function checkTable(
  prisma: PrismaClient,
  table: OrphanCheckTable,
  options: OrphanCheckOptions,
): Promise<OrphanCheckTableResult> {
  const quoted = Prisma.raw(`"${table}"`)
  const batchSize = options.batchSize ?? MAINTENANCE_BATCH.orphanScanBatchSize
  const pauseMs = options.pauseMs ?? MAINTENANCE_BATCH.pauseMs
  let cursor = options.resumeFrom?.[table] ?? MIN_BIGINT
  const result: OrphanCheckTableResult = {
    table,
    scannedRows: 0,
    orphanAccountCount: 0,
    orphanRowCount: 0,
    sampleAccountIds: [],
    nextCursor: null,
  }

  for (let batch = 0; ; batch++) {
    if (options.maxBatchesPerTable !== undefined && batch >= options.maxBatchesPerTable) {
      result.nextCursor = cursor
      return result
    }

    const [page] = await prisma.$queryRaw<PageRow[]>`
      WITH page AS (
        SELECT "accountId" FROM ${quoted}
        WHERE "accountId" > ${cursor}::bigint
        ORDER BY "accountId"
        LIMIT ${batchSize}
      ), ids AS (
        SELECT DISTINCT "accountId" FROM page
      ), orphans AS (
        SELECT i."accountId" FROM ids i
        LEFT JOIN "Account" a ON a."id" = i."accountId"
        WHERE a."id" IS NULL
      )
      SELECT
        (SELECT max("accountId") FROM page)::text AS "lastAccountId",
        (SELECT count(*) FROM page)::int AS "scannedRows",
        COALESCE((SELECT array_agg("accountId"::text ORDER BY "accountId") FROM orphans), '{}') AS "orphanIds"`
    if (page.lastAccountId === null) return result

    result.scannedRows += page.scannedRows
    if (page.orphanIds.length > 0) {
      const [{ rows }] = await prisma.$queryRaw<{ rows: number }[]>`
        SELECT count(*)::int AS rows FROM ${quoted}
        WHERE "accountId" = ANY(${page.orphanIds}::bigint[])`
      result.orphanAccountCount += page.orphanIds.length
      result.orphanRowCount += rows
      result.sampleAccountIds.push(
        ...page.orphanIds.slice(0, SAMPLE_SIZE - result.sampleAccountIds.length),
      )
    }

    cursor = page.lastAccountId
    if (page.scannedRows < batchSize) return result
    await sleep(pauseMs)
  }
}

/**
 * FK を持たない表の accountId が Account に存在するかを、表ごとに検査する。
 * 何も書き込まない。
 */
export async function runOrphanCheck(
  prisma: PrismaClient,
  options: OrphanCheckOptions = {},
): Promise<OrphanCheckTableResult[]> {
  const results: OrphanCheckTableResult[] = []
  for (const table of options.tables ?? ORPHAN_CHECK_TABLES) {
    results.push(await checkTable(prisma, table, options))
  }
  return results
}

const ORPHAN_ISSUE_FINGERPRINT = computeFingerprint('orphan_rows', { component: 'db' })

/**
 * 検査結果を OperationalIssue に反映する。孤児があれば activate し、
 * 全表を最後まで検査して孤児が無ければ resolve する。打ち切った検査では resolve しない。
 */
export async function reportOrphanIssue(
  prisma: PrismaClient,
  results: readonly OrphanCheckTableResult[],
  now: Date,
): Promise<void> {
  const orphanTables = results.filter((result) => result.orphanAccountCount > 0)
  const observationKey = now.toISOString().slice(0, 10)

  if (orphanTables.length === 0) {
    if (results.some((result) => result.nextCursor !== null)) return
    const issue = await prisma.operationalIssue.findUnique({
      where: { fingerprint: ORPHAN_ISSUE_FINGERPRINT },
    })
    if (issue?.status !== 'active') return
    await prisma.operationalIssue.update({
      where: { id: issue.id },
      data: { status: 'resolved', resolvedAt: now },
    })
    await prisma.operationalIssueOccurrence.upsert({
      where: {
        issueId_observationKey: { issueId: issue.id, observationKey: `${observationKey}:resolved` },
      },
      create: {
        issueId: issue.id,
        observedAt: now,
        stateTransition: 'resolved',
        severity: issue.severity,
        sourceType: 'db',
        sourceId: 'orphan_check',
        observationKey: `${observationKey}:resolved`,
      },
      update: {},
    })
    return
  }

  const issue = await prisma.operationalIssue.upsert({
    where: { fingerprint: ORPHAN_ISSUE_FINGERPRINT },
    create: {
      component: 'db',
      type: 'orphan_rows',
      fingerprint: ORPHAN_ISSUE_FINGERPRINT,
      status: 'active',
      severity: 'high',
      firstDetectedAt: now,
      lastDetectedAt: now,
    },
    update: { status: 'active', severity: 'high', lastDetectedAt: now, resolvedAt: null },
  })
  const measurements = Object.fromEntries(
    orphanTables.map((result) => [
      result.table,
      {
        orphanAccountCount: result.orphanAccountCount,
        orphanRowCount: result.orphanRowCount,
        sampleAccountIds: result.sampleAccountIds,
      },
    ]),
  )
  await prisma.operationalIssueOccurrence.upsert({
    where: { issueId_observationKey: { issueId: issue.id, observationKey } },
    create: {
      issueId: issue.id,
      observedAt: now,
      stateTransition: 'activated',
      severity: 'high',
      sourceType: 'db',
      sourceId: 'orphan_check',
      measurements,
      observationKey,
    },
    update: {},
  })
  logger.warn(`orphan rows detected: ${JSON.stringify(measurements)}`)
}
