import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { Logger } from '@book000/node-utils'
import type { Account, AnalysisWorkItem, PrismaClient, Tweet } from './generated/prisma'
import { LabelRuleRegistry } from './labels/registry'
import { buildAccountFeatureBundle } from './labels/build-account-feature-bundle'
import type { buildDuplicateReplyIndex } from './labels/duplicate-reply-index'
import type { buildReplyHijackIndex } from './labels/reply-hijack-index'
import type { FollowGraphLabelIndex } from './labels/follow-graph-label-index'
import {
  claimWorkItemBatchByIds,
  completeAccountRelabelWorkItemsBulk,
  peekWorkItemCandidates,
  requestAccountRelabelBulk,
  type WorkItemCandidate,
} from './db/analysis-work-item-repository'
import {
  recordAccountLabelsBulkForAccounts,
  ensureLabelDefinitionsForRules,
  type AccountLabelBulkInput,
} from './db/label-repository'
import { CRAWL_LIMITS } from './config/crawl-limits'
import { loadReplyCorpus } from './db/reply-corpus'
import { loadRecentTweetsForAccounts, findTweetTextsByIds } from './db/tweet-repository'
import { buildDuplicateReplyIndex as buildDuplicateReplyIndexImpl } from './labels/duplicate-reply-index'
import { buildReplyHijackIndex as buildReplyHijackIndexImpl } from './labels/reply-hijack-index'
import { buildFollowGraphLabelIndex } from './labels/follow-graph-label-index'
import { ALL_LABEL_RULES } from './labels/all-rules'
import { getPrismaClient, disconnectPrisma } from './db/client'
import { initMonitoring, captureException } from './monitoring/sentry'
import {
  getRelabelerLabelLookupChunkSize,
  getRelabelerProducerBatchSize,
  getRelabelerWorkerBatchSize,
  getRelabelerWorkerChunkSize,
  getRelabelerWorkerConcurrency,
} from './config/env'

const logger = Logger.configure('relabel-worker')

const ACCOUNT_RELABEL_KIND = 'account_relabel'
const LEASE_DURATION_MS = 5 * 60 * 1000

export interface PeekAccountRelabelCandidatesOptions {
  limit: number
}

/**
 * account_relabel kind の claim 候補を、lease を更新せず read-only で確定する。
 * follow-graph index を評価前に1回構築するために、実際の claim より先に呼ぶ。
 * @param prisma - Prisma クライアント
 * @param options - 上限件数
 * @returns 候補 WorkItem の id・triggerId 一覧
 */
export async function peekAccountRelabelCandidates(
  prisma: PrismaClient,
  options: PeekAccountRelabelCandidatesOptions,
): Promise<WorkItemCandidate[]> {
  return peekWorkItemCandidates(prisma, { kinds: [ACCOUNT_RELABEL_KIND], limit: options.limit })
}

export interface ClaimAccountRelabelBatchByIdsOptions {
  ids: string[]
  leaseOwner: string
}

/**
 * peekAccountRelabelCandidates で固定した WorkItem id 集合のうち、渡された chunk 分だけを claim する。
 * @param prisma - Prisma クライアント
 * @param options - claim 対象の id 一覧と lease owner 名
 * @returns 実際に claim できた work item 一覧
 */
export async function claimAccountRelabelBatchByIds(
  prisma: PrismaClient,
  options: ClaimAccountRelabelBatchByIdsOptions,
): Promise<AnalysisWorkItem[]> {
  return claimWorkItemBatchByIds(prisma, {
    ids: options.ids,
    leaseOwner: options.leaseOwner,
    leaseDurationMs: LEASE_DURATION_MS,
  })
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
 * `evaluateAccountRelabelItemGroup` がラベル永続化・work item 完了を分割する account 数。
 * グループ全体を 1 回で永続化・完了すると、その 1 回の失敗で maxAttempts を使い切った account が二度と claim も再 enqueue もされず取り残される。
 * 失敗時に失われる範囲をこのサブバッチ単位に留める。
 */
const ACCOUNT_RELABEL_COMPLETION_SUB_BATCH_SIZE = 100

/**
 * claim 済みの account_relabel work item のうち、1 グループ分 (account 複数件) を評価する。
 * account 取得・tweet 取得は、それぞれ 1 ラウンドトリップにまとめる。
 * 個々の account のルール評価は DB I/O を伴わない CPU 処理であり、try/catch で分離しているため、1 account の不正なデータでグループ全体の評価が失敗することはない。
 * サブバッチの失敗は他のサブバッチの完了済み結果を巻き込まない。
 * @param prisma - Prisma クライアント
 * @param group - claimAccountRelabelBatchByIds で claim 済みの work item のうち 1 グループ分
 * @param options - 評価に使うルールレジストリと共有インデックス・lease owner 名
 * @returns succeeded (requeue 含む) にできた件数
 */
async function evaluateAccountRelabelItemGroup(
  prisma: PrismaClient,
  group: AnalysisWorkItem[],
  options: Omit<EvaluateAccountRelabelItemsOptions, 'concurrency'>,
): Promise<number> {
  if (group.length === 0) return 0

  const accountIds = group.map((item) => item.triggerId)
  let accounts: Account[]
  let tweetsByAccountId: Map<string, Tweet[]>
  let parentTweetTextById: Map<string, string>
  try {
    ;[accounts, tweetsByAccountId] = await Promise.all([
      prisma.account.findMany({ where: { id: { in: accountIds } } }),
      loadRecentTweetsForAccounts(prisma, accountIds, CRAWL_LIMITS.recentTweetsPerAccount),
    ])

    const allRecentTweets = [...tweetsByAccountId.values()].flat()
    const replyParentIds = [
      ...new Set(
        allRecentTweets
          .filter(
            (tweet): tweet is Tweet & { inReplyToTweetId: string } =>
              tweet.inReplyToTweetId !== null,
          )
          .map((tweet) => tweet.inReplyToTweetId),
      ),
    ]
    // labelLookupChunkSize は accountLabelLatest の chunk 済み IN 句と同じ値を流用し、
    // 大規模グループで1回の IN 句に数千件の id を渡さないようにする。
    const lookupChunkSize = getRelabelerLabelLookupChunkSize()
    parentTweetTextById = new Map()
    for (let i = 0; i < replyParentIds.length; i += lookupChunkSize) {
      const chunk = replyParentIds.slice(i, i + lookupChunkSize)
      const chunkResult = await findTweetTextsByIds(prisma, chunk)
      for (const [id, text] of chunkResult) parentTweetTextById.set(id, text)
    }
  } catch (error) {
    logger.error(
      `Failed to fetch account/tweet data for a group (accounts: ${group.length})`,
      error as Error,
    )
    captureException(error, { source: 'relabel-worker.evaluateAccountRelabelItems' })
    await prisma.analysisWorkItem.updateMany({
      where: { id: { in: group.map((item) => item.id) }, status: { not: 'succeeded' } },
      data: { lastErrorSummary: String(error).slice(0, 500) },
    })
    return 0
  }
  const accountById = new Map(accounts.map((account) => [account.id, account]))

  const labelsByAccountId = new Map<string, AccountLabelBulkInput[]>()
  const failedItemIds = new Set<string>()
  for (const item of group) {
    // account が既に削除されている場合、これ以上評価しようがないため succeeded 扱いで終端する。
    const account = accountById.get(item.triggerId)
    if (!account) continue
    try {
      const recentTweets = tweetsByAccountId.get(account.id) ?? []
      const bundle = buildAccountFeatureBundle(
        account,
        recentTweets,
        options.duplicateReplyIndex,
        options.replyHijackIndex,
        options.followGraphLabelIndex,
        parentTweetTextById,
      )
      const labels: AccountLabelBulkInput[] = []
      for (const { rule, result } of options.registry.applyAll(bundle)) {
        const labelDefinitionId = options.labelDefinitionIds.get(rule.key)
        if (!labelDefinitionId) continue
        labels.push({
          accountId: account.id,
          labelDefinitionId,
          method: rule.key,
          ruleVersion: rule.version,
          result,
        })
      }
      labelsByAccountId.set(account.id, labels)
    } catch (error) {
      logger.error(`Failed to relabel account ${item.triggerId}`, error as Error)
      captureException(error, { source: 'relabel-worker.evaluateAccountRelabelItems' })
      failedItemIds.add(item.id)
      await prisma.analysisWorkItem
        .update({
          where: { id: item.id },
          data: { lastErrorSummary: String(error).slice(0, 500) },
        })
        .catch(() => undefined)
    }
  }

  const completableItems = group.filter((item) => !failedItemIds.has(item.id))
  let succeeded = 0
  for (
    let offset = 0;
    offset < completableItems.length;
    offset += ACCOUNT_RELABEL_COMPLETION_SUB_BATCH_SIZE
  ) {
    const subBatch = completableItems.slice(
      offset,
      offset + ACCOUNT_RELABEL_COMPLETION_SUB_BATCH_SIZE,
    )
    try {
      const subBatchLabels = subBatch.flatMap((item) => labelsByAccountId.get(item.triggerId) ?? [])
      if (subBatchLabels.length > 0) {
        await recordAccountLabelsBulkForAccounts(prisma, {
          sourceKind: 'relabel',
          labels: subBatchLabels,
        })
      }
      const completions = await completeAccountRelabelWorkItemsBulk(prisma, {
        workItemIds: subBatch.map((item) => item.id),
        leaseOwner: options.leaseOwner,
      })
      succeeded += completions.length
    } catch (error) {
      logger.error(
        `Failed to persist labels / complete work items for a sub-batch (accounts: ${subBatch.length})`,
        error as Error,
      )
      captureException(error, { source: 'relabel-worker.evaluateAccountRelabelItems' })
      // completeAccountRelabelWorkItemsBulk が commit 済みでレスポンスだけ失われた場合、
      // 対象は既に succeeded になっている。status ガードで上書きしないようにする。
      await prisma.analysisWorkItem
        .updateMany({
          where: { id: { in: subBatch.map((item) => item.id) }, status: { not: 'succeeded' } },
          data: { lastErrorSummary: String(error).slice(0, 500) },
        })
        .catch(() => undefined)
    }
  }
  return succeeded
}

/**
 * claim 済みの account_relabel work item を評価・永続化する。
 * account 取得・tweet 取得の DB I/O を concurrency 個のグループに分割し、グループ単位にまとめて実行することで 1 account ごとの往復を避ける。
 * ラベル永続化・work item 完了はグループ内でさらに小さいサブバッチに分けて行う (詳細は `evaluateAccountRelabelItemGroup` を参照)。
 * @param prisma - Prisma クライアント
 * @param items - claimAccountRelabelBatchByIds で claim 済みの work item 一覧
 * @param options - 評価に使うルールレジストリ・共有インデックス・並行度・lease owner 名
 * @returns succeeded (requeue 含む) にできた件数
 */
export async function evaluateAccountRelabelItems(
  prisma: PrismaClient,
  items: AnalysisWorkItem[],
  options: EvaluateAccountRelabelItemsOptions,
): Promise<EvaluateAccountRelabelItemsResult> {
  const concurrency = Math.max(1, options.concurrency)
  const groups: AnalysisWorkItem[][] = Array.from({ length: concurrency }, () => [])
  for (const [index, item] of items.entries()) {
    groups[index % concurrency].push(item)
  }

  const groupResults = await Promise.allSettled(
    groups.map((group) => evaluateAccountRelabelItemGroup(prisma, group, options)),
  )

  // 1 グループの DB 書き込み失敗を Promise.all で扱うと、他グループが成功していても呼び出し元まで例外が伝播し、その成功分を lastErrorSummary で失敗扱いに巻き込んでしまう。
  // 失敗したグループの work item は lease を保持したまま残るため、lease 失効後に再試行される。
  let succeeded = 0
  for (const result of groupResults) {
    if (result.status === 'fulfilled') {
      succeeded += result.value
      continue
    }
    logger.error('Relabel drain failed in a group', result.reason as Error)
    captureException(result.reason, { source: 'relabel-worker.evaluateAccountRelabelItems' })
  }

  return { succeeded }
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
  const targetLabelDefinitionIds = [...options.labelDefinitionIds.values()]
  const lookupChunkSize = getRelabelerLabelLookupChunkSize()
  const latestRows: { accountId: string; labelDefinitionId: string; ruleVersion: string }[] = []
  for (let i = 0; i < accountIds.length; i += lookupChunkSize) {
    const chunk = accountIds.slice(i, i + lookupChunkSize)
    const rows = await prisma.accountLabelLatest.findMany({
      where: { accountId: { in: chunk }, labelDefinitionId: { in: targetLabelDefinitionIds } },
      select: { accountId: true, labelDefinitionId: true, ruleVersion: true },
    })
    for (const row of rows) latestRows.push(row)
  }
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
 * 1 cycle 分の producer (incremental scan) + worker (peek → bounded index 構築 → chunk 単位の claim/evaluate) を実行する。
 * DB クライアントの確保・解放を呼び出し元の runRelabelWorkerCycle に委ねているのは、
 * テストで prisma を差し替えられるようにするため。
 * @param prisma - Prisma クライアント
 */
export async function runRelabelWorkerCycleOnce(prisma: PrismaClient): Promise<void> {
  const registry = new LabelRuleRegistry()
  for (const rule of ALL_LABEL_RULES) registry.register(rule)
  const labelDefinitionIds = await ensureLabelDefinitionsForRules(prisma, registry.getAll())

  const leaseOwner = `${hostname()}-${process.pid}-${randomUUID()}`
  const concurrency = getRelabelerWorkerConcurrency()
  const totalLimit = getRelabelerWorkerBatchSize() * concurrency

  let candidates = await peekAccountRelabelCandidates(prisma, { limit: totalLimit })
  if (candidates.length < totalLimit) {
    const scanResult = await scanForStaleAccounts(prisma, {
      registry,
      labelDefinitionIds,
      batchSize: getRelabelerProducerBatchSize(),
    })
    logger.info(
      `Relabel scan: ${scanResult.scanned} accounts scanned, ${scanResult.requested} requested`,
    )
    candidates = await peekAccountRelabelCandidates(prisma, { limit: totalLimit })
  } else {
    logger.info(`Relabel scan: skipped because ${candidates.length} drain candidates are ready`)
  }

  if (candidates.length === 0) {
    logger.info('Relabel drain: 0 candidates, skipping index construction')
    return
  }

  const candidateAccountIds = candidates.map((candidate) => candidate.triggerId)
  const candidateWorkItemIds = candidates.map((candidate) => candidate.id)

  let duplicateReplyIndex: ReturnType<typeof buildDuplicateReplyIndex>
  let replyHijackIndex: ReturnType<typeof buildReplyHijackIndex>
  let followGraphLabelIndex: FollowGraphLabelIndex
  try {
    // CrawlRun に紐づかないため、既存の全件対象の挙動を維持するよう現在時刻を watermark として渡す。
    const replyCorpus = await loadReplyCorpus(prisma, new Date())
    duplicateReplyIndex = buildDuplicateReplyIndexImpl(replyCorpus)
    replyHijackIndex = buildReplyHijackIndexImpl(replyCorpus)
    // follow-graph signal を使わないルールのラベルまで集計対象に含めると、
    // 対象 account 数が同じでも不要な JOIN 対象ラベルが増えてクエリコストが膨らむ。
    const followGraphLabelDefinitionIds = new Map(
      [...labelDefinitionIds.entries()].filter(([key]) =>
        registry.getAll().some((rule) => rule.key === key && rule.usesFollowGraphSignal),
      ),
    )
    // ある chunk の評価による AccountLabelLatest 更新を、同じ cycle の後続 chunk の
    // follow-graph signal が参照してしまう自己フィードバックを避けるための構築である。
    followGraphLabelIndex = await buildFollowGraphLabelIndex(
      prisma,
      followGraphLabelDefinitionIds,
      {
        accountIds: candidateAccountIds,
        chunkSize: getRelabelerWorkerChunkSize(),
      },
    )
  } catch (error) {
    // この時点ではまだ何も claim していないため、lease されたまま残る WorkItem は 0 件のまま失敗する。
    logger.error('Relabel drain failed before any claim (index construction)', error as Error)
    captureException(error, { source: 'relabel-worker.runRelabelWorkerCycleOnce' })
    throw error
  }

  const chunkSize = getRelabelerWorkerChunkSize()
  let totalClaimed = 0
  let totalSucceeded = 0
  try {
    for (let i = 0; i < candidateWorkItemIds.length; i += chunkSize) {
      const idsChunk = candidateWorkItemIds.slice(i, i + chunkSize)
      let claimedChunk: AnalysisWorkItem[] = []
      try {
        // 他ワーカーとの競合で一部が既に claim 済みの場合、SKIP LOCKED により自然に除外される。
        // 除外分を候補外の WorkItem で補充することはせず、次 cycle の scan/peek に委ねる。
        claimedChunk = await claimAccountRelabelBatchByIds(prisma, { ids: idsChunk, leaseOwner })
        if (claimedChunk.length === 0) continue
        totalClaimed += claimedChunk.length

        const evaluateResult = await evaluateAccountRelabelItems(prisma, claimedChunk, {
          registry,
          labelDefinitionIds,
          duplicateReplyIndex,
          replyHijackIndex,
          followGraphLabelIndex,
          concurrency,
          leaseOwner,
        })
        totalSucceeded += evaluateResult.succeeded
      } catch (error) {
        // 取り残されるのはこの chunk の claim 済み item だけであり、既に complete 済みの
        // 前段の chunk は影響を受けない。claim 自体が失敗した場合は何も lease されていない。
        logger.error(
          `Relabel drain failed in a chunk (claimed so far: ${totalClaimed}, succeeded so far: ${totalSucceeded})`,
          error as Error,
        )
        captureException(error, { source: 'relabel-worker.runRelabelWorkerCycleOnce' })
        if (claimedChunk.length > 0) {
          await Promise.all(
            claimedChunk.map((item) =>
              prisma.analysisWorkItem
                .update({
                  where: { id: item.id },
                  data: { lastErrorSummary: String(error).slice(0, 500) },
                })
                .catch(() => undefined),
            ),
          )
        }
        throw error
      }
    }
  } finally {
    logger.info(`Relabel drain: ${totalClaimed} claimed, ${totalSucceeded} succeeded`)
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
