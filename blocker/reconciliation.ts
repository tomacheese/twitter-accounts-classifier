import { Logger } from '@book000/node-utils'
import { withTwitterRetry, type OpenApiClientContext } from 'twitter-client'
import type { PrismaClient } from './generated/prisma'
import { recordSuccessfulBlock } from './db/block-repository'
import { recordBlockAction } from './db/block-run-repository'
import {
  findStalledOutboxEntries,
  findExistingBlockedIds,
  findOutboxEntryIdsWithBlockAction,
  markOutboxRemoteSucceeded,
  markOutboxLocalPersisted,
  markOutboxRemoteFailed,
  type StalledOutboxEntry,
} from './db/outbox-repository'
import { captureException } from './monitoring/sentry'

const logger = Logger.configure('reconciliation')

/** `reconcileOutboxEntries` が必要とする依存関数一式。 */
export interface ReconcileOutboxEntriesDependencies {
  prisma: PrismaClient
  /** reconciliation の対象範囲を決める blocker アカウント。 */
  blockerId: string
  client: OpenApiClientContext
  findStalledOutboxEntries: typeof findStalledOutboxEntries
  findExistingBlockedIds: typeof findExistingBlockedIds
  findOutboxEntryIdsWithBlockAction: typeof findOutboxEntryIdsWithBlockAction
  recordSuccessfulBlock: typeof recordSuccessfulBlock
  recordBlockAction: typeof recordBlockAction
  markOutboxRemoteSucceeded: typeof markOutboxRemoteSucceeded
  markOutboxLocalPersisted: typeof markOutboxLocalPersisted
  markOutboxRemoteFailed: typeof markOutboxRemoteFailed
  /** Twitter 側で実際にブロック済みの一覧を取得する。`pending_remote` の ambiguous state 解消にのみ使う。 */
  fetchRemotelyBlockedIds: (client: OpenApiClientContext) => Promise<Set<string>>
}

/**
 * @param deps - reconciliation に必要な依存関数一式
 * @param entry - 対象の停滞した outbox entry
 * @param blockExists - 対応する Block 行が既に存在するか
 * @param actionExists - 対応する BlockAction が既に存在するか
 */
async function reconcileRemoteSucceeded(
  deps: ReconcileOutboxEntriesDependencies,
  entry: StalledOutboxEntry,
  blockExists: boolean,
  actionExists: boolean,
): Promise<void> {
  if (!blockExists) {
    await deps.recordSuccessfulBlock(
      deps.prisma,
      entry.blockerId,
      entry.blockedId,
      entry.blockAccountRunId,
    )
  }
  if (!actionExists) {
    await deps.recordBlockAction(deps.prisma, {
      blockAccountRunId: entry.blockAccountRunId,
      blockerId: entry.blockerId,
      blockedId: entry.blockedId,
      labelDefinitionId: entry.labelDefinitionId,
      confidence: entry.confidence,
      result: 'success',
      errorMessage: null,
      outboxEntryId: entry.id,
    })
  }
  await deps.markOutboxLocalPersisted(deps.prisma, entry.id, true)
}

/**
 * `pending_remote` は remote 実行の成否が不明な ambiguous state である。
 * 未実施なら remote_failed にして、次回の block cycle で通常の候補として再選定できるようにする。
 * @param deps - reconciliation に必要な依存関数一式
 * @param entry - 対象の停滞した outbox entry
 * @param remotelyBlockedIds - Twitter 側で実際にブロック済みの blockedId 集合
 */
async function reconcilePendingRemote(
  deps: ReconcileOutboxEntriesDependencies,
  entry: StalledOutboxEntry,
  remotelyBlockedIds: Set<string>,
): Promise<void> {
  const isBlocked = remotelyBlockedIds.has(entry.blockedId)
  await (isBlocked
    ? deps.markOutboxRemoteSucceeded(deps.prisma, entry.id, true)
    : deps.markOutboxRemoteFailed(deps.prisma, entry.id))
}

/**
 * 未 reconcile の outbox entry を巡回し、Twitter credential を持つ blocker 側でのみ判定可能な状態 (remote 側の実ブロック済み確認) を解消する。
 * Analyzer には持ち込まない。1 件の失敗が残りの entry の reconciliation を止めないよう、entry ごとに例外を分離する。
 * @param deps - reconciliation に必要な依存関数一式
 * @param prisma - Prisma クライアント
 */
export async function reconcileOutboxEntries(
  deps: ReconcileOutboxEntriesDependencies,
  prisma: PrismaClient,
): Promise<void> {
  const stalledEntries = await deps.findStalledOutboxEntries(prisma, deps.blockerId)
  if (stalledEntries.length === 0) return

  const remoteSucceededEntries = stalledEntries.filter(
    (entry) => entry.status === 'remote_succeeded',
  )
  const pendingRemoteEntries = stalledEntries.filter((entry) => entry.status === 'pending_remote')

  const [blockedIds, actionOutboxIds, remotelyBlockedIds] = await Promise.all([
    deps.findExistingBlockedIds(
      deps.prisma,
      deps.blockerId,
      remoteSucceededEntries.map((entry) => entry.blockedId),
    ),
    deps.findOutboxEntryIdsWithBlockAction(
      deps.prisma,
      remoteSucceededEntries.map((entry) => entry.id),
    ),
    pendingRemoteEntries.length > 0
      ? deps.fetchRemotelyBlockedIds(deps.client)
      : Promise.resolve(new Set<string>()),
  ])

  for (const entry of stalledEntries) {
    try {
      if (entry.status === 'remote_succeeded') {
        await reconcileRemoteSucceeded(
          deps,
          entry,
          blockedIds.has(entry.blockedId),
          actionOutboxIds.has(entry.id),
        )
      } else if (entry.status === 'pending_remote') {
        await reconcilePendingRemote(deps, entry, remotelyBlockedIds)
      }
    } catch (error) {
      logger.error(`Failed to reconcile outbox entry ${entry.id}`, error as Error)
      captureException(error, { blockerId: deps.blockerId, outboxEntryId: entry.id })
    }
  }
}

// ブロック一覧は際限なく増える可能性があるため、reconciliation 1 回あたりの全ページ走査を避け、この件数分のページを見て見つからなければ未実施と判断する。
const BLOCK_LIST_PAGE_CAP = 20
const BLOCK_LIST_PAGE_SIZE = 200

/**
 * `crawler` の `syncBlocksPhase` と異なり全件同期が目的ではなく、reconciliation 対象の停滞 entry 群が一覧に含まれるかどうかだけを知れればよいため、
 * entry ごとに一覧を再取得するのではなくここで一度だけ取得して集合として返す。
 * @param client - ログイン済みの OpenAPI クライアント
 * @returns Twitter 側で実際にブロック済みの blockedId 集合
 */
export async function fetchRemotelyBlockedIds(client: OpenApiClientContext): Promise<Set<string>> {
  const blockedIds = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < BLOCK_LIST_PAGE_CAP; page++) {
    const result = await withTwitterRetry(() =>
      client.blocksClient.getBlocksPage(cursor, BLOCK_LIST_PAGE_SIZE),
    )
    for (const user of result.users) blockedIds.add(user.restId)
    if (!result.nextCursor) break
    cursor = result.nextCursor
  }
  return blockedIds
}
