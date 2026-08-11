import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { Logger } from '@book000/node-utils'
import type { AnalysisWorkItem, PrismaClient } from './generated/prisma'
import { LabelRuleRegistry } from './labels/registry'
import { buildAccountFeatureBundle } from './labels/build-account-feature-bundle'
import type { buildDuplicateReplyIndex } from './labels/duplicate-reply-index'
import type { buildReplyHijackIndex } from './labels/reply-hijack-index'
import type { FollowGraphLabelIndex } from './labels/follow-graph-label-index'
import {
  claimNextWorkItem,
  completeAccountRelabelWorkItem,
  requestAccountRelabelBulk,
} from './db/analysis-work-item-repository'
import { recordAccountLabelsBulk, ensureLabelDefinitionsForRules } from './db/label-repository'
import { CRAWL_LIMITS } from './config/crawl-limits'
import { loadReplyCorpus } from './db/reply-corpus'
import { buildDuplicateReplyIndex as buildDuplicateReplyIndexImpl } from './labels/duplicate-reply-index'
import { buildReplyHijackIndex as buildReplyHijackIndexImpl } from './labels/reply-hijack-index'
import { buildFollowGraphLabelIndex } from './labels/follow-graph-label-index'
import { ALL_LABEL_RULES } from './labels/all-rules'
import { getPrismaClient, disconnectPrisma } from './db/client'
import { initMonitoring, captureException } from './monitoring/sentry'
import {
  getRelabelerProducerBatchSize,
  getRelabelerWorkerBatchSize,
  getRelabelerWorkerConcurrency,
} from './config/env'

const logger = Logger.configure('relabel-worker')

const ACCOUNT_RELABEL_KIND = 'account_relabel'
const LEASE_DURATION_MS = 5 * 60 * 1000

export interface ClaimAccountRelabelBatchOptions {
  batchSize: number
  leaseOwner: string
}

/**
 * account_relabel kind の work item を batchSize を上限に claim する。
 * claim 自体は 1 行の `FOR UPDATE SKIP LOCKED` UPDATE のため、並列化する実益がない。
 * @param prisma - Prisma クライアント
 * @param options - 1 cycle あたりの claim 上限件数と lease owner 名
 * @returns claim できた work item の一覧 (対象が尽きた時点で打ち切るため、batchSize より少ないことがある)
 */
export async function claimAccountRelabelBatch(
  prisma: PrismaClient,
  options: ClaimAccountRelabelBatchOptions,
): Promise<AnalysisWorkItem[]> {
  const items: AnalysisWorkItem[] = []
  for (let i = 0; i < options.batchSize; i++) {
    const item = await claimNextWorkItem(prisma, {
      kinds: [ACCOUNT_RELABEL_KIND],
      leaseOwner: options.leaseOwner,
      leaseDurationMs: LEASE_DURATION_MS,
    })
    if (!item) break
    items.push(item)
  }
  return items
}

export interface EvaluateAccountRelabelItemsOptions {
  registry: LabelRuleRegistry
  labelDefinitionIds: Map<string, string>
  duplicateReplyIndex: ReturnType<typeof buildDuplicateReplyIndex>
  replyHijackIndex: ReturnType<typeof buildReplyHijackIndex>
  followGraphLabelIndex: FollowGraphLabelIndex
  concurrency: number
  leaseOwner: string
}

export interface EvaluateAccountRelabelItemsResult {
  succeeded: number
}

/**
 * claim 済みの account_relabel work item を、1 account ずつ評価・永続化する。
 * account 単位の try/catch で例外を吸収しているため、chunk を跨いだ Promise.all 並列化でも、
 * 1 account の失敗が他の account やチャンクを巻き込むことはない。
 * @param prisma - Prisma クライアント
 * @param items - claimAccountRelabelBatch で claim 済みの work item 一覧
 * @param options - 評価に使うルールレジストリ・共有インデックス・並行度・lease owner 名
 * @returns succeeded (requeue 含む) にできた件数
 */
export async function evaluateAccountRelabelItems(
  prisma: PrismaClient,
  items: AnalysisWorkItem[],
  options: EvaluateAccountRelabelItemsOptions,
): Promise<EvaluateAccountRelabelItemsResult> {
  async function evaluateOne(item: AnalysisWorkItem): Promise<boolean> {
    try {
      const account = await prisma.account.findUnique({ where: { id: item.triggerId } })
      if (account) {
        const recentTweets = await prisma.tweet.findMany({
          where: { accountId: account.id },
          orderBy: { createdAt: 'desc' },
          take: CRAWL_LIMITS.recentTweetsPerAccount,
        })
        const bundle = buildAccountFeatureBundle(
          account,
          recentTweets,
          options.duplicateReplyIndex,
          options.replyHijackIndex,
          options.followGraphLabelIndex,
        )
        const labelsToPersist = options.registry.applyAll(bundle).flatMap(({ rule, result }) => {
          const labelDefinitionId = options.labelDefinitionIds.get(rule.key)
          if (!labelDefinitionId) return []
          return [{ labelDefinitionId, method: rule.key, ruleVersion: rule.version, result }]
        })
        if (labelsToPersist.length > 0) {
          await recordAccountLabelsBulk(prisma, {
            accountId: account.id,
            sourceKind: 'relabel',
            labels: labelsToPersist,
          })
        }
      }
      // account が既に削除されている場合、これ以上評価しようがないため succeeded 扱いで終端する。
      const outcome = await completeAccountRelabelWorkItem(prisma, {
        workItemId: item.id,
        leaseOwner: options.leaseOwner,
      })
      return outcome !== 'lease_lost'
    } catch (error) {
      logger.error(`Failed to relabel account ${item.triggerId}`, error as Error)
      captureException(error, { source: 'relabel-worker.evaluateAccountRelabelItems' })
      await prisma.analysisWorkItem
        .update({
          where: { id: item.id },
          data: { lastErrorSummary: String(error).slice(0, 500) },
        })
        .catch(() => undefined)
      return false
    }
  }

  const concurrency = Math.max(1, options.concurrency)
  const chunks: AnalysisWorkItem[][] = Array.from({ length: concurrency }, () => [])
  for (const [index, item] of items.entries()) {
    chunks[index % concurrency].push(item)
  }

  const chunkResults = await Promise.all(
    chunks.map(async (chunk) => {
      let succeeded = 0
      for (const item of chunk) {
        if (await evaluateOne(item)) succeeded++
      }
      return succeeded
    }),
  )

  return { succeeded: chunkResults.reduce((sum, count) => sum + count, 0) }
}

interface StaleAccountRow {
  id: string
}

export interface ScanForStaleAccountsOptions {
  registry: LabelRuleRegistry
  labelDefinitionIds: Map<string, string>
  batchSize: number
}

export interface ScanForStaleAccountsResult {
  scanned: number
  requested: number
  /** カーソルがテーブル終端に達し、先頭へ巻き戻して scan したか。 */
  wrapped: boolean
}

const SCAN_CURSOR_ID = 'singleton'

/**
 * RelabelScanCursor の位置から id 昇順で bounded 件数だけ Account を scan し、
 * ruleVersion が古い (account, rule) を持つ account に account_relabel を要求する。
 * テーブル終端に達したら次回呼び出しのために先頭へ巻き戻す。
 * @param prisma - Prisma クライアント
 * @param options - 評価対象ルールと 1 回あたりの scan 件数
 * @returns scan した件数と account_relabel を要求した件数
 */
export async function scanForStaleAccounts(
  prisma: PrismaClient,
  options: ScanForStaleAccountsOptions,
): Promise<ScanForStaleAccountsResult> {
  const cursor = await prisma.relabelScanCursor.findUnique({ where: { id: SCAN_CURSOR_ID } })
  const accounts: StaleAccountRow[] = await prisma.account.findMany({
    select: { id: true },
    orderBy: { id: 'asc' },
    take: options.batchSize,
    ...(cursor?.lastScannedAccountId
      ? { skip: 1, cursor: { id: cursor.lastScannedAccountId } }
      : {}),
  })

  const wrapped = accounts.length === 0
  const targets = wrapped
    ? await prisma.account.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
        take: options.batchSize,
      })
    : accounts

  if (targets.length === 0) return { scanned: 0, requested: 0, wrapped: false }

  const accountIds = targets.map((account) => account.id)
  const latestRows = await prisma.accountLabelLatest.findMany({
    where: { accountId: { in: accountIds } },
    select: { accountId: true, labelDefinitionId: true, ruleVersion: true },
  })
  const latestByKey = new Map(
    latestRows.map((row) => [`${row.accountId}:${row.labelDefinitionId}`, row.ruleVersion]),
  )
  const rules = options.registry.getAll()

  const staleAccountIds: string[] = []
  for (const account of targets) {
    const isStale = rules.some((rule) => {
      const labelDefinitionId = options.labelDefinitionIds.get(rule.key)
      if (!labelDefinitionId) return false
      return latestByKey.get(`${account.id}:${labelDefinitionId}`) !== rule.version
    })
    if (isStale) staleAccountIds.push(account.id)
  }
  await requestAccountRelabelBulk(prisma, staleAccountIds)

  await prisma.relabelScanCursor.upsert({
    where: { id: SCAN_CURSOR_ID },
    create: { id: SCAN_CURSOR_ID, lastScannedAccountId: accountIds.at(-1) },
    update: { lastScannedAccountId: accountIds.at(-1) },
  })

  return { scanned: targets.length, requested: staleAccountIds.length, wrapped }
}

/**
 * 1 cycle 分の producer (incremental scan) + worker (claim → bounded index 構築 → evaluate) を実行する。
 * DB クライアントの確保・解放を呼び出し元の runRelabelWorkerCycle に委ねているのは、
 * テストで prisma を差し替えられるようにするため。
 * @param prisma - Prisma クライアント
 */
export async function runRelabelWorkerCycleOnce(prisma: PrismaClient): Promise<void> {
  const registry = new LabelRuleRegistry()
  for (const rule of ALL_LABEL_RULES) registry.register(rule)
  const labelDefinitionIds = await ensureLabelDefinitionsForRules(prisma, registry.getAll())

  const scanResult = await scanForStaleAccounts(prisma, {
    registry,
    labelDefinitionIds,
    batchSize: getRelabelerProducerBatchSize(),
  })
  logger.info(
    `Relabel scan: ${scanResult.scanned} accounts scanned, ${scanResult.requested} requested`,
  )

  const leaseOwner = `${hostname()}-${process.pid}-${randomUUID()}`
  const concurrency = getRelabelerWorkerConcurrency()
  const claimed = await claimAccountRelabelBatch(prisma, {
    batchSize: getRelabelerWorkerBatchSize() * concurrency,
    leaseOwner,
  })
  if (claimed.length === 0) {
    logger.info('Relabel drain: 0 claimed, skipping index construction')
    return
  }

  try {
    const accountIds = claimed.map((item) => item.triggerId)
    // CrawlRun に紐づかないため、既存の全件対象の挙動を維持するよう現在時刻を watermark として渡す。
    const replyCorpus = await loadReplyCorpus(prisma, new Date())
    // follow-graph signal を使わないルールのラベルまで集計対象に含めると、
    // 対象 account 数が同じでも不要な JOIN 対象ラベルが増えてクエリコストが膨らむ。
    const followGraphLabelDefinitionIds = new Map(
      [...labelDefinitionIds.entries()].filter(([key]) =>
        registry.getAll().some((rule) => rule.key === key && rule.usesFollowGraphSignal),
      ),
    )
    const followGraphLabelIndex = await buildFollowGraphLabelIndex(
      prisma,
      followGraphLabelDefinitionIds,
      { accountIds },
    )
    const evaluateResult = await evaluateAccountRelabelItems(prisma, claimed, {
      registry,
      labelDefinitionIds,
      duplicateReplyIndex: buildDuplicateReplyIndexImpl(replyCorpus),
      replyHijackIndex: buildReplyHijackIndexImpl(replyCorpus),
      followGraphLabelIndex,
      concurrency,
      leaseOwner,
    })
    logger.info(`Relabel drain: ${claimed.length} claimed, ${evaluateResult.succeeded} succeeded`)
  } catch (error) {
    // index 構築が失敗すると claim 済みの全件が評価前に取り残されるため、次回 scan での
    // 原因調査に使えるよう、release はせず lastErrorSummary だけ書き残して rethrow する。
    logger.error('Relabel drain failed before evaluation', error as Error)
    captureException(error, { source: 'relabel-worker.runRelabelWorkerCycleOnce' })
    await Promise.all(
      claimed.map((item) =>
        prisma.analysisWorkItem
          .update({
            where: { id: item.id },
            data: { lastErrorSummary: String(error).slice(0, 500) },
          })
          .catch(() => undefined),
      ),
    )
    throw error
  }
}

/**
 * relabeler-entrypoint.sh のループから毎周期呼ばれる 1 サイクル分の実行。
 * DB クライアントの確保・解放を担い、実処理は runRelabelWorkerCycleOnce に委譲する。
 */
async function runRelabelWorkerCycle(): Promise<void> {
  const prisma = getPrismaClient()
  try {
    await runRelabelWorkerCycleOnce(prisma)
  } finally {
    await disconnectPrisma()
  }
}

// このモジュールを import しただけでは実際の cycle が走らないようにするガード。
// 直接実行 (`node dist/relabel-worker.js`)した場合のみ動作する。require/module は、
// CommonJS を採用する本プロジェクトでこれを判定するのに適した手段である。
// eslint-disable-next-line unicorn/prefer-module
if (require.main === module) {
  initMonitoring()
  runRelabelWorkerCycle().catch((error: unknown) => {
    logger.error('Relabel worker cycle failed', error as Error)
    captureException(error)
    process.exitCode = 1
  })
}
