import type { PrismaClient } from '../generated/prisma'

/** データ鮮度の判定結果。 */
export type FreshnessStatus = 'current' | 'delayed' | 'stale' | 'unknown'

/**
 * computeFreshnessStatus の入力。
 */
export interface ComputeFreshnessStatusInput {
  /** 直近で成功した時刻。 */
  lastSuccessAt: Date | undefined
  /** 想定している実行間隔 (ミリ秒)。 */
  cadenceMs: number
  /** delayed とみなすまでの経過時間 (ミリ秒)。 */
  delayedAfterMs: number
  /** stale とみなすまでの経過時間 (ミリ秒)。 */
  staleAfterMs: number
  /** 判定の基準時刻。 */
  now: Date
}

/**
 * @param input - 直近成功時刻としきい値
 * @returns 鮮度状態
 */
export function computeFreshnessStatus(input: ComputeFreshnessStatusInput): FreshnessStatus {
  if (!input.lastSuccessAt) return 'unknown'
  const elapsedMs = input.now.getTime() - input.lastSuccessAt.getTime()
  if (elapsedMs >= input.staleAfterMs) return 'stale'
  if (elapsedMs >= input.delayedAfterMs) return 'delayed'
  return 'current'
}

/** refreshReadModelFreshness の入力。 */
export interface RefreshReadModelFreshnessInput {
  /** 想定している再構築間隔 (ミリ秒)。 */
  cadenceMs: number
  /** delayed とみなすまでの経過時間 (ミリ秒)。 */
  delayedAfterMs: number
  /** stale とみなすまでの経過時間 (ミリ秒)。 */
  staleAfterMs: number
  /** 判定の基準時刻。 */
  now: Date
}

/**
 * @param freshness - 鮮度状態
 * @returns ReadModelState.status に記録する値
 */
function toReadModelStatus(freshness: FreshnessStatus): string {
  return freshness === 'current' ? 'healthy' : freshness
}

/**
 * publish 側は成功のたびに healthy を書くだけで、その後何も公開されなくなった
 * 状態を検出しない。経過時間で status を落とし込む役目をここへ集約する。
 * failed は publish が記録した確定的な失敗であり、時間経過で上書きしない。
 * @param prisma - Prisma クライアント
 * @param input - しきい値と基準時刻
 * @returns 状態を更新した modelKey の一覧
 */
export async function refreshReadModelFreshness(
  prisma: PrismaClient,
  input: RefreshReadModelFreshnessInput,
): Promise<string[]> {
  const states = await prisma.readModelState.findMany()
  const updatedModelKeys: string[] = []

  for (const state of states) {
    if (state.status === 'failed') continue

    const freshness = computeFreshnessStatus({
      lastSuccessAt: state.lastSuccessAt ?? undefined,
      cadenceMs: input.cadenceMs,
      delayedAfterMs: input.delayedAfterMs,
      staleAfterMs: input.staleAfterMs,
      now: input.now,
    })
    const status = toReadModelStatus(freshness)
    if (status === state.status) continue

    await prisma.readModelState.update({
      where: { modelKey: state.modelKey },
      data: {
        status,
        expectedNextAt: state.lastSuccessAt
          ? new Date(state.lastSuccessAt.getTime() + input.cadenceMs)
          : null,
        delayedAt:
          freshness === 'delayed' || freshness === 'stale' ? (state.delayedAt ?? input.now) : null,
        staleAt: freshness === 'stale' ? (state.staleAt ?? input.now) : null,
      },
    })
    updatedModelKeys.push(state.modelKey)
  }

  return updatedModelKeys
}
