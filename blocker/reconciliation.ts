import { Logger } from '@book000/node-utils'
import { withTwitterRetry, type OpenApiClientContext } from 'twitter-client'
import type { PrismaClient } from './generated/prisma'
import { recordSuccessfulBlock } from './db/block-repository'
import { recordBlockAction } from './db/block-run-repository'
import {
  findStalledOutboxEntries,
  hasBlockRow,
  hasBlockAction,
  markOutboxRemoteSucceeded,
  markOutboxLocalPersisted,
  markOutboxRemoteFailed,
  type StalledOutboxEntry,
} from './db/outbox-repository'
import { captureException } from './monitoring/sentry'

const logger = Logger.configure('reconciliation')

export interface ReconcileOutboxEntriesDependencies {
  prisma: PrismaClient
  /** reconciliation の対象範囲を決める blocker アカウント。 */
  blockerId: string
  client: OpenApiClientContext
  findStalledOutboxEntries: typeof findStalledOutboxEntries
  hasBlockRow: typeof hasBlockRow
  hasBlockAction: typeof hasBlockAction
  recordSuccessfulBlock: typeof recordSuccessfulBlock
  recordBlockAction: typeof recordBlockAction
  markOutboxRemoteSucceeded: typeof markOutboxRemoteSucceeded
  markOutboxLocalPersisted: typeof markOutboxLocalPersisted
  markOutboxRemoteFailed: typeof markOutboxRemoteFailed
  /** Twitter 側で実際にブロック済みかを確認する。`pending_remote` の ambiguous state 解消にのみ使う。 */
  isRemotelyBlocked: (client: OpenApiClientContext, blockedId: string) => Promise<boolean>
}

/**
 * @param deps - reconciliation に必要な依存関数一式
 * @param entry - 対象の停滞した outbox entry
 */
async function reconcileRemoteSucceeded(
  deps: ReconcileOutboxEntriesDependencies,
  entry: StalledOutboxEntry,
): Promise<void> {
  const [blockExists, actionExists] = await Promise.all([
    deps.hasBlockRow(deps.prisma, entry.blockerId, entry.blockedId),
    deps.hasBlockAction(deps.prisma, entry.id),
  ])
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
 * Twitter 側で実際にブロック済みなら remote_succeeded に進める。
 * 未実施なら remote_failed にして、次回の block cycle で通常の候補として再選定できるようにする。
 * @param deps - reconciliation に必要な依存関数一式
 * @param entry - 対象の停滞した outbox entry
 */
async function reconcilePendingRemote(
  deps: ReconcileOutboxEntriesDependencies,
  entry: StalledOutboxEntry,
): Promise<void> {
  const isBlocked = await deps.isRemotelyBlocked(deps.client, entry.blockedId)
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
  for (const entry of stalledEntries) {
    try {
      if (entry.status === 'remote_succeeded') {
        await reconcileRemoteSucceeded(deps, entry)
      } else if (entry.status === 'pending_remote') {
        await reconcilePendingRemote(deps, entry)
      }
    } catch (error) {
      logger.error(`Failed to reconcile outbox entry ${entry.id}`, error as Error)
      captureException(error, { blockerId: deps.blockerId, outboxEntryId: entry.id })
    }
  }
}

// ブロック一覧は際限なく増える可能性があるため、reconciliation 1 件あたりの全ページ走査を避け、この件数分のページを見て見つからなければ未実施と判断する。
const BLOCK_LIST_PAGE_CAP = 20
const BLOCK_LIST_PAGE_SIZE = 200

/**
 * `crawler` の `syncBlocksPhase` と異なり全件同期が目的ではなく、単一の `blockedId` が一覧に含まれるかどうかだけを知れればよいため、一覧の先頭から必要な分だけ走査する。
 * @param client - ログイン済みの OpenAPI クライアント
 * @param blockedId - 確認対象のアカウント
 * @returns Twitter 側で実際にブロック済みなら true
 */
export async function isRemotelyBlocked(
  client: OpenApiClientContext,
  blockedId: string,
): Promise<boolean> {
  let cursor: string | undefined
  for (let page = 0; page < BLOCK_LIST_PAGE_CAP; page++) {
    const result = await withTwitterRetry(() =>
      client.blocksClient.getBlocksPage(cursor, BLOCK_LIST_PAGE_SIZE),
    )
    if (result.users.some((user) => user.restId === blockedId)) return true
    if (!result.nextCursor) return false
    cursor = result.nextCursor
  }
  return false
}
