import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { Logger } from '@book000/node-utils'
import type { PrismaClient } from './generated/prisma'
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

const logger = Logger.configure('relabel-worker')

const ACCOUNT_RELABEL_KIND = 'account_relabel'
const LEASE_DURATION_MS = 5 * 60 * 1000

export interface DrainAccountRelabelQueueOptions {
  registry: LabelRuleRegistry
  labelDefinitionIds: Map<string, string>
  duplicateReplyIndex: ReturnType<typeof buildDuplicateReplyIndex>
  replyHijackIndex: ReturnType<typeof buildReplyHijackIndex>
  followGraphLabelIndex: FollowGraphLabelIndex
  batchSize: number
  leaseOwner: string
}

export interface DrainAccountRelabelQueueResult {
  claimed: number
  succeeded: number
}

/**
 * account_relabel kind の work item を bounded batch で claim し、1 account ずつ評価・永続化する。
 * @param prisma - Prisma クライアント
 * @param options - 評価に使うルールレジストリ・共有インデックス・batch size・lease owner 名
 * @returns claim した件数と succeeded (requeue 含む) にできた件数
 */
export async function drainAccountRelabelQueue(
  prisma: PrismaClient,
  options: DrainAccountRelabelQueueOptions,
): Promise<DrainAccountRelabelQueueResult> {
  let claimed = 0
  let succeeded = 0

  for (let i = 0; i < options.batchSize; i++) {
    const item = await claimNextWorkItem(prisma, {
      kinds: [ACCOUNT_RELABEL_KIND],
      leaseOwner: options.leaseOwner,
      leaseDurationMs: LEASE_DURATION_MS,
    })
    if (!item) break
    claimed++

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
      if (outcome !== 'lease_lost') succeeded++
    } catch (error) {
      logger.error(`Failed to relabel account ${item.triggerId}`, error as Error)
      captureException(error, { source: 'relabel-worker.drainAccountRelabelQueue' })
      await prisma.analysisWorkItem
        .update({
          where: { id: item.id },
          data: { lastErrorSummary: String(error).slice(0, 500) },
        })
        .catch(() => undefined)
    }
  }

  return { claimed, succeeded }
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

// producer/worker それぞれの 1 entrypoint loop あたりの上限。
// crawl loop の周期を重ねても新規ルールの backfill が長期化しない値を選んでいる。
const RELABEL_PRODUCER_BATCH_SIZE = 5000
const RELABEL_WORKER_BATCH_SIZE = 2000

/**
 * entrypoint.sh の crawl loop から毎周期呼ばれる 1 サイクル分の実行。
 * producer (incremental scan) を 1 ページ進めたのち、worker (queue drain) を bounded 件数だけ処理する。
 */
async function runRelabelWorkerCycle(): Promise<void> {
  const prisma = getPrismaClient()
  try {
    const registry = new LabelRuleRegistry()
    for (const rule of ALL_LABEL_RULES) registry.register(rule)
    const labelDefinitionIds = await ensureLabelDefinitionsForRules(prisma, registry.getAll())

    const scanResult = await scanForStaleAccounts(prisma, {
      registry,
      labelDefinitionIds,
      batchSize: RELABEL_PRODUCER_BATCH_SIZE,
    })
    logger.info(
      `Relabel scan: ${scanResult.scanned} accounts scanned, ${scanResult.requested} requested`,
    )

    const replyCorpus = await loadReplyCorpus(prisma)
    const followGraphLabelIndex = await buildFollowGraphLabelIndex(prisma, labelDefinitionIds)
    const drainResult = await drainAccountRelabelQueue(prisma, {
      registry,
      labelDefinitionIds,
      duplicateReplyIndex: buildDuplicateReplyIndexImpl(replyCorpus),
      replyHijackIndex: buildReplyHijackIndexImpl(replyCorpus),
      followGraphLabelIndex,
      batchSize: RELABEL_WORKER_BATCH_SIZE,
      leaseOwner: `${hostname()}-${process.pid}-${randomUUID()}`,
    })
    logger.info(`Relabel drain: ${drainResult.claimed} claimed, ${drainResult.succeeded} succeeded`)
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
