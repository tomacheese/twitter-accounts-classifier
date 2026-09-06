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

// storage-guard (別プロセス) が測るまで relabel 側は何も知らないため、直前の判定を
// プロセス内メモリに保持して hysteresis の「復帰条件を満たすまで blocked を維持する」を
// 実現する。永続化はしない (プロセス再起動時は ok 相当から再判定して構わない)。
let lastKnownStatus: RelabelStorageCircuitBreakerStatus = 'ok'

/**
 * テストが hysteresis 状態をまたいで汚染し合わないよう、モジュール内メモリを初期値へ戻す。
 * 本番コードからは呼ばない。
 */
export function resetRelabelStorageCircuitBreakerStateForTest(): void {
  lastKnownStatus = 'ok'
}

/**
 * `StorageCapacityState` を読み、relabel が新規クレームを続けてよいかを判定する。
 * 行が存在しない、または古すぎる (`RELABEL_STORAGE_MAX_STALE_SECONDS` 超過) 場合は、
 * storage-guard 自体の停止・障害を「空き容量に問題なし」と誤認しないよう fail-closed で
 * `blocked` を返す。
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
    lastKnownStatus = 'blocked'
    return {
      status: 'blocked',
      availableGib: state?.availableGib ?? null,
      usedPercent: state?.usedPercent ?? null,
    }
  }

  const { availableGib, usedPercent } = state
  const isBlockedCondition =
    availableGib < getRelabelStorageBlockedAvailableGib() ||
    usedPercent >= getRelabelStorageBlockedUsedPercent()
  const resumeConditionsMet =
    availableGib > getRelabelStorageHysteresisResumeAvailableGib() &&
    usedPercent < getRelabelStorageHysteresisResumeUsedPercent()

  if (isBlockedCondition || (lastKnownStatus === 'blocked' && !resumeConditionsMet)) {
    lastKnownStatus = 'blocked'
    return { status: 'blocked', availableGib, usedPercent }
  }

  const isWarningCondition =
    availableGib < getRelabelStorageWarningAvailableGib() ||
    usedPercent >= getRelabelStorageWarningUsedPercent()
  lastKnownStatus = isWarningCondition ? 'warning' : 'ok'
  return { status: lastKnownStatus, availableGib, usedPercent }
}
