import type { PrismaClient } from './generated/prisma'
import {
  getRelabelStorageBlockedAvailableGib,
  getRelabelStorageBlockedUsedPercent,
  getRelabelStorageHysteresisResumeAvailableGib,
  getRelabelStorageHysteresisResumeUsedPercent,
  getRelabelStorageMaxStaleSeconds,
  getRelabelStorageWarningAvailableGib,
  getRelabelStorageWarningUsedPercent,
} from './config/env'

export type RelabelStorageCircuitBreakerStatus = 'ok' | 'warning' | 'blocked'

export interface RelabelStorageCircuitBreakerResult {
  status: RelabelStorageCircuitBreakerStatus
  availableGib: number | null
  usedPercent: number | null
}

export interface RelabelStorageCircuitBreakerOptions {
  now?: Date
}

/**
 * `StorageCapacityState` を読み、relabel が新規クレームを続けてよいかを判定する。
 * 行が存在しない、または古すぎる (`RELABEL_STORAGE_MAX_STALE_SECONDS` 超過) 場合は、
 * storage-guard 自体の停止・障害を「空き容量に問題なし」と誤認しないよう fail-closed で
 * `blocked` を返す。hysteresis の「復帰条件を満たすまで blocked を維持する」判定は
 * `StorageCapacityState.relabelBlocked` に永続化する。プロセス内メモリだけで持つと
 * relabeler 再起動のたびに判定不能な状態から始まってしまい、warning 相当の値を
 * 再起動直後の最初の計測として受け取った際に本来維持すべき blocked を見失う
 * (逆に blocked からの回復途中の値を warning へ誤って抜けさせてしまう) ため、
 * storage-guard の書き込みを跨いで維持する必要がある。
 * @param prisma - Prisma クライアント
 * @param options - `now` (テスト用の基準時刻。既定は `new Date()`)
 * @returns 判定結果
 */
export async function checkRelabelStorageCircuitBreaker(
  prisma: PrismaClient,
  options: RelabelStorageCircuitBreakerOptions = {},
): Promise<RelabelStorageCircuitBreakerResult> {
  const now = options.now ?? new Date()
  const state = await prisma.storageCapacityState.findUnique({ where: { id: 'singleton' } })

  const maxStaleSeconds = getRelabelStorageMaxStaleSeconds()
  const isStale =
    state === null || (now.getTime() - state.measuredAt.getTime()) / 1000 > maxStaleSeconds
  if (isStale) {
    return {
      status: 'blocked',
      availableGib: state?.availableGib ?? null,
      usedPercent: state?.usedPercent ?? null,
    }
  }

  const { availableGib, usedPercent, relabelBlocked: wasBlocked } = state
  const isBlockedCondition =
    availableGib < getRelabelStorageBlockedAvailableGib() ||
    usedPercent >= getRelabelStorageBlockedUsedPercent()
  const resumeConditionsMet =
    availableGib > getRelabelStorageHysteresisResumeAvailableGib() &&
    usedPercent < getRelabelStorageHysteresisResumeUsedPercent()
  const isBlocked = isBlockedCondition || (wasBlocked && !resumeConditionsMet)

  if (isBlocked !== wasBlocked) {
    await prisma.storageCapacityState.update({
      where: { id: 'singleton' },
      data: { relabelBlocked: isBlocked },
    })
  }

  if (isBlocked) {
    return { status: 'blocked', availableGib, usedPercent }
  }

  const isWarningCondition =
    availableGib < getRelabelStorageWarningAvailableGib() ||
    usedPercent >= getRelabelStorageWarningUsedPercent()
  return { status: isWarningCondition ? 'warning' : 'ok', availableGib, usedPercent }
}
