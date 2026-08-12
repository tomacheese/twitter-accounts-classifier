import { Logger } from '@book000/node-utils'
import type { PrismaClient } from '../generated/prisma'
import { getPrismaClient, disconnectPrisma } from '../db/client'
import { detectRunFailures } from '../operational-issues/detect-run-failures'
import { publishAttentionAndOverview } from '../worker-processors'

const logger = Logger.configure('analyzer:cleanup-deprecated-work-item-kinds')

/** 一度だけ強制的に resolve してよい component と、その適用条件。 */
interface LegacyComponentTarget {
  component: string
  /**
   * true: 二度と新規 activate されない component (廃止済み kind) なので、active issue を
   * 無条件で全件対象にする。
   * false: 現行コードでも新規 activate され得る component なので、`before` カットオフ
   * より前に検出された issue だけを対象にする。
   */
  unconditional: boolean
}

export const LEGACY_COMPONENT_TARGETS: LegacyComponentTarget[] = [
  // 廃止済み kind。二度と WorkItem が処理されないため無条件で resolve してよい。
  { component: 'analyzer:label_metrics', unconditional: true },
  // stage 分離導入前の generic component。導入後も未分類 failure の activate 先として
  // 使われ続けるため、deploy 前のカットオフより前の issue だけを対象にする。
  { component: 'analyzer:label_aggregate_refresh', unconditional: false },
]

export interface CleanupResult {
  component: string
  /** resolve 前の対象 active issue 件数。 */
  activeCountBefore: number
  /** resolve 後の対象 active issue 件数。apply: false のときは activeCountBefore と同じ値になる。 */
  activeCountAfter: number
}

/**
 * 対象 component に残った active な run_failure issue を集計し、
 * apply が true のときだけ resolve する。
 * `unconditional: false` の component は `before` より前に検出された issue だけを対象にし、
 * deploy 後に新しく発生した未分類 failure まで一緒に resolve しないようにする。
 * @param prisma - Prisma クライアント
 * @param options - apply フラグ (false なら集計のみ)、判定基準時刻、deploy 前カットオフ時刻
 * @returns component ごとの解消前後の対象 active 件数
 */
export async function cleanupDeprecatedWorkItemKindIssues(
  prisma: PrismaClient,
  options: { apply: boolean; now: Date; before: Date },
): Promise<CleanupResult[]> {
  const results: CleanupResult[] = []
  for (const target of LEGACY_COMPONENT_TARGETS) {
    const cutoff = target.unconditional ? undefined : options.before
    const where = {
      component: target.component,
      type: 'run_failure',
      status: 'active',
      ...(cutoff ? { lastDetectedAt: { lte: cutoff } } : {}),
    }
    const activeCountBefore = await prisma.operationalIssue.count({ where })
    if (options.apply && activeCountBefore > 0) {
      await detectRunFailures(prisma, {
        component: target.component,
        runId: 'deprecated-kind-cleanup',
        runStatus: 'succeeded',
        errorSummary: null,
        now: options.now,
        supersedeCutoff: cutoff,
      })
    }
    const activeCountAfter = options.apply
      ? await prisma.operationalIssue.count({ where })
      : activeCountBefore
    results.push({ component: target.component, activeCountBefore, activeCountAfter })
  }
  return results
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const beforeArg = process.argv.find((arg) => arg.startsWith('--before='))
  if (!beforeArg) {
    logger.error('missing required --before=<ISO timestamp> (fix a deploy cutoff before running)')
    process.exitCode = 1
    return
  }
  const before = new Date(beforeArg.slice('--before='.length))

  const prisma = getPrismaClient()
  await prisma.$connect()
  const now = new Date()

  const results = await cleanupDeprecatedWorkItemKindIssues(prisma, { apply, now, before })
  for (const result of results) {
    logger.info(
      `${result.component}: ${result.activeCountBefore} active issue(s) before, ` +
        `${result.activeCountAfter} after`,
    )
  }

  if (apply) {
    await publishAttentionAndOverview(prisma, now)
    logger.info('re-published attention/overview projections')
  } else {
    logger.info('dry-run: pass --apply to resolve and re-publish projections')
  }

  await disconnectPrisma()

  // post-condition: apply 後に対象 active issue が残っていれば、実行したこと自体ではなく
  // 実際に解消できたことを完了条件として非 0 exit にする。
  const remaining = results.filter((result) => apply && result.activeCountAfter > 0)
  if (remaining.length > 0) {
    for (const result of remaining) {
      logger.error(
        `${result.component}: still ${result.activeCountAfter} active issue(s) after cleanup`,
      )
    }
    process.exitCode = 1
  }
}

// このモジュールを import しただけでは実行されないようにするガード。
// 直接実行 (`node dist/scripts/cleanup-deprecated-work-item-kinds.js`) した場合のみ動作する。
// require/module は、CommonJS を採用する本プロジェクトでこれを判定するのに適した手段である。
// eslint-disable-next-line unicorn/prefer-module
if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error('cleanup failed', error as Error)
    process.exitCode = 1
  })
}
