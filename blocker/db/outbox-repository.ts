import type { PrismaClient } from '../generated/prisma'

/** 未解決 (まだ local_persisted/remote_failed に至っていない) outbox 状態。 */
const UNRESOLVED_STATUSES = ['pending_remote', 'remote_succeeded'] as const

export interface FindOrCreateOutboxEntryInput {
  blockAccountRunId: string
  blockerId: string
  blockedId: string
  labelDefinitionId: string
  confidence: number
}

export interface OutboxEntryRef {
  id: string
  status: string
}

/**
 * `createBlock` (remote) 実行前に呼ぶことで、DB 障害でどの段階が失敗しても直前に
 * 確定した状態が残るようにする。同一 (blockerId, blockedId) の未解決 entry が
 * 既に存在する場合は新規作成せず、その entry を再利用して処理を resume する。
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
  if (existing && (UNRESOLVED_STATUSES as readonly string[]).includes(existing.status)) {
    return { id: existing.id, status: existing.status }
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
  return { id: created.id, status: created.status }
}

/**
 * @param prisma - Prisma クライアント
 * @param outboxEntryId - 対象 entry の ID
 */
export async function markOutboxRemoteSucceeded(
  prisma: PrismaClient,
  outboxEntryId: string,
): Promise<void> {
  await prisma.blockOutboxEntry.update({
    where: { id: outboxEntryId },
    data: { status: 'remote_succeeded', remoteSucceededAt: new Date() },
  })
}

/**
 * @param prisma - Prisma クライアント
 * @param outboxEntryId - 対象 entry の ID
 */
export async function markOutboxLocalPersisted(
  prisma: PrismaClient,
  outboxEntryId: string,
): Promise<void> {
  await prisma.blockOutboxEntry.update({
    where: { id: outboxEntryId },
    data: { status: 'local_persisted', localPersistedAt: new Date() },
  })
}

/**
 * `createBlock` 自体が失敗した終端状態として記録する。reconciliation の対象にはしないが、
 * `selectBlockCandidates` の除外条件には含めない (未解決扱いにしない) ため、次回の
 * block cycle が通常の候補として再選定できる。
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

/** 停滞判定の対象となった outbox entry。 */
export interface StalledOutboxEntry {
  id: string
  status: string
  blockerId: string
  blockedId: string
  labelDefinitionId: string
  confidence: number
  blockAccountRunId: string
}

/**
 * Twitter への実ブロック確認 (`isRemotelyBlocked`) は blocker アカウントごとの認証済み
 * クライアントを必要とするため、この一覧も同じ blockerId に絞って返す。
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
  return prisma.blockOutboxEntry.findMany({
    where: {
      blockerId,
      status: { in: ['pending_remote', 'remote_succeeded'] },
      createdAt: { lt: new Date(Date.now() - staleAfterMs) },
    },
  })
}

/**
 * @param prisma - Prisma クライアント
 * @param blockerId - ブロックを実行したアカウント
 * @param blockedId - ブロックされたアカウント
 * @returns 対応する Block 行が既に存在すれば true
 */
export async function hasBlockRow(
  prisma: PrismaClient,
  blockerId: string,
  blockedId: string,
): Promise<boolean> {
  const count = await prisma.block.count({ where: { blockerId, blockedId } })
  return count > 0
}

/**
 * @param prisma - Prisma クライアント
 * @param outboxEntryId - 対象 outbox entry の ID
 * @returns 対応する BlockAction が既に存在すれば true
 */
export async function hasBlockAction(
  prisma: PrismaClient,
  outboxEntryId: string,
): Promise<boolean> {
  const count = await prisma.blockAction.count({ where: { outboxEntryId } })
  return count > 0
}
