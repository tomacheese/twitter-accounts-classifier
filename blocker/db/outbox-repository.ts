import type { PrismaClient } from '../generated/prisma'

/** BlockOutboxEntry.status が取りうる値。 */
export type OutboxEntryStatus =
  'pending_remote' | 'remote_succeeded' | 'local_persisted' | 'remote_failed' | 'remote_skipped'

/** 未解決 (まだ終端状態に至っていない) outbox 状態。 */
const UNRESOLVED_STATUSES: readonly OutboxEntryStatus[] = ['pending_remote', 'remote_succeeded']

/** `findOrCreateOutboxEntry` の入力。 */
export interface FindOrCreateOutboxEntryInput {
  blockAccountRunId: string
  blockerId: string
  blockedId: string
  labelDefinitionId: string
  confidence: number
}

/** `findOrCreateOutboxEntry` が返す outbox entry の参照情報。 */
export interface OutboxEntryRef {
  id: string
  status: OutboxEntryStatus
}

/**
 * `createBlock` (remote) 実行前に呼ぶことで、DB 障害でどの段階が失敗しても直前に確定した状態が残るようにする。
 * 既存行が `remote_failed` など解決済みの場合は、一意制約により新規行を作れないため既存行を pending_remote に戻して再利用する。
 * @param prisma - Prisma クライアント
 * @param input - 対象ペアと根拠ラベル・確信度
 * @returns 使用する outbox entry の id と現在の status
 */
export async function findOrCreateOutboxEntry(
  prisma: PrismaClient,
  input: FindOrCreateOutboxEntryInput,
): Promise<OutboxEntryRef> {
  const existing = await prisma.blockOutboxEntry.findUnique({
    where: { blockerId_blockedId: { blockerId: input.blockerId, blockedId: input.blockedId } },
  })
  if (existing) {
    if (UNRESOLVED_STATUSES.includes(existing.status as OutboxEntryStatus)) {
      return { id: existing.id, status: existing.status as OutboxEntryStatus }
    }

    const reset = await prisma.blockOutboxEntry.update({
      where: { id: existing.id },
      data: {
        status: 'pending_remote',
        remoteSucceededAt: null,
        localPersistedAt: null,
        blockAccountRunId: input.blockAccountRunId,
        labelDefinitionId: input.labelDefinitionId,
        confidence: input.confidence,
      },
    })
    return { id: reset.id, status: reset.status as OutboxEntryStatus }
  }

  const created = await prisma.blockOutboxEntry.create({
    data: {
      blockAccountRunId: input.blockAccountRunId,
      blockerId: input.blockerId,
      blockedId: input.blockedId,
      labelDefinitionId: input.labelDefinitionId,
      confidence: input.confidence,
      status: 'pending_remote',
    },
  })
  return { id: created.id, status: created.status as OutboxEntryStatus }
}

/**
 * @param prisma - Prisma クライアント
 * @param outboxEntryId - 対象 entry の ID
 * @param reconciled - reconciliation 経由の解消なら true。`reconciledAt` に記録し、attemptBlock の通常経路と区別できるようにする
 */
export async function markOutboxRemoteSucceeded(
  prisma: PrismaClient,
  outboxEntryId: string,
  reconciled = false,
): Promise<void> {
  await prisma.blockOutboxEntry.update({
    where: { id: outboxEntryId },
    data: {
      status: 'remote_succeeded',
      remoteSucceededAt: new Date(),
      ...(reconciled ? { reconciledAt: new Date() } : {}),
    },
  })
}

/**
 * @param prisma - Prisma クライアント
 * @param outboxEntryId - 対象 entry の ID
 * @param reconciled - reconciliation 経由の解消なら true。`reconciledAt` に記録し、attemptBlock の通常経路と区別できるようにする
 */
export async function markOutboxLocalPersisted(
  prisma: PrismaClient,
  outboxEntryId: string,
  reconciled = false,
): Promise<void> {
  await prisma.blockOutboxEntry.update({
    where: { id: outboxEntryId },
    data: {
      status: 'local_persisted',
      localPersistedAt: new Date(),
      ...(reconciled ? { reconciledAt: new Date() } : {}),
    },
  })
}

/**
 * `createBlock` 自体が失敗した終端状態として記録する。
 * reconciliation の対象にはしないが、`selectBlockCandidates` の除外条件には含めない (未解決扱いにしない) ため、次回の block cycle が通常の候補として再選定できる。
 * 再選定時に `findOrCreateOutboxEntry` が呼ばれた場合は、この行を pending_remote に戻して再利用する。
 * @param prisma - Prisma クライアント
 * @param outboxEntryId - 対象 entry の ID
 */
export async function markOutboxRemoteFailed(
  prisma: PrismaClient,
  outboxEntryId: string,
): Promise<void> {
  await prisma.blockOutboxEntry.update({
    where: { id: outboxEntryId },
    data: { status: 'remote_failed' },
  })
}

/**
 * ブロック対象が存在しない場合の終端状態として記録する。
 * `remote_failed` とは異なり `(blockerId, blockedId)` 単位の `remoteSkipCount` を持つ。
 * 読み取り→書き込みの2段階を避けて同時実行下でも取りこぼさないよう、原子的にインクリメントする。
 * `remoteSkipCount` が上限未満でも、cooldown 経過前は候補選定から除外され続ける。
 * @param prisma - Prisma クライアント
 * @param outboxEntryId - 対象 entry の ID
 */
export async function markOutboxRemoteSkipped(
  prisma: PrismaClient,
  outboxEntryId: string,
): Promise<void> {
  await prisma.blockOutboxEntry.update({
    where: { id: outboxEntryId },
    data: {
      status: 'remote_skipped',
      remoteSkipCount: { increment: 1 },
      lastRemoteSkippedAt: new Date(),
    },
  })
}

/** 停滞判定の対象となった outbox entry。 */
export interface StalledOutboxEntry {
  id: string
  status: OutboxEntryStatus
  blockerId: string
  blockedId: string
  labelDefinitionId: string
  confidence: number
  blockAccountRunId: string
}

/**
 * Twitter への実ブロック確認 (`isRemotelyBlocked`) は blocker アカウントごとの認証済みクライアントを必要とするため、この一覧も同じ blockerId に絞って返す。
 * @param prisma - Prisma クライアント
 * @param blockerId - 対象の blocker アカウント
 * @param staleAfterMs - 停滞と判定するまでの経過時間 (ミリ秒)
 * @returns 停滞した outbox entry の一覧
 */
export async function findStalledOutboxEntries(
  prisma: PrismaClient,
  blockerId: string,
  staleAfterMs = 30 * 60 * 1000,
): Promise<StalledOutboxEntry[]> {
  const entries = await prisma.blockOutboxEntry.findMany({
    where: {
      blockerId,
      status: { in: [...UNRESOLVED_STATUSES] },
      createdAt: { lt: new Date(Date.now() - staleAfterMs) },
    },
  })
  return entries.map((entry) => ({ ...entry, status: entry.status as OutboxEntryStatus }))
}

/**
 * entry ごとに個別 query を発行すると停滞 entry 数に比例して DB 往復が増えるため、対象の blockedId をまとめて 1 query で引く。
 * @param prisma - Prisma クライアント
 * @param blockerId - ブロックを実行したアカウント
 * @param blockedIds - 確認対象の blockedId 一覧
 * @returns 対応する Block 行が既に存在する blockedId の集合
 */
export async function findExistingBlockedIds(
  prisma: PrismaClient,
  blockerId: string,
  blockedIds: string[],
): Promise<Set<string>> {
  if (blockedIds.length === 0) return new Set()
  const rows = await prisma.block.findMany({
    where: { blockerId, blockedId: { in: blockedIds } },
    select: { blockedId: true },
  })
  return new Set(rows.map((row) => row.blockedId))
}

/**
 * entry ごとに個別 query を発行すると停滞 entry 数に比例して DB 往復が増えるため、対象の outboxEntryId をまとめて 1 query で引く。
 * @param prisma - Prisma クライアント
 * @param outboxEntryIds - 確認対象の outbox entry ID 一覧
 * @returns 対応する BlockAction が既に存在する outboxEntryId の集合
 */
export async function findOutboxEntryIdsWithBlockAction(
  prisma: PrismaClient,
  outboxEntryIds: string[],
): Promise<Set<string>> {
  if (outboxEntryIds.length === 0) return new Set()
  const rows = await prisma.blockAction.findMany({
    where: { outboxEntryId: { in: outboxEntryIds } },
    select: { outboxEntryId: true },
  })
  return new Set(rows.flatMap((row) => (row.outboxEntryId ? [row.outboxEntryId] : [])))
}
