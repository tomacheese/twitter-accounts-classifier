import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { Logger } from '@book000/node-utils'
import { getPrismaClient, disconnectPrisma } from './db/client'
import { initMonitoring, captureException } from './monitoring/sentry'
import { runWorkerLoopOnce, type WorkerLoopDeps } from './worker-loop'
import {
  processLabelMetrics,
  processFindingGeneration,
  processReadModelRefresh,
  processWeeklyReviewIngest,
  processBlockReconciliation,
  processRetentionSweep,
  enqueueDailyRetentionSweep,
  refreshReadModelFreshnessFromPolicy,
  handleWorkItemSettled,
} from './worker-processors'
import { getWorkerConcurrency } from './config/env'
import { DEFAULT_POLICY_PATH, loadPolicy, recordPolicyVersion } from './policy/load-policy'
import type { PrismaClient } from './generated/prisma'

const logger = Logger.configure('analyzer')

/**
 * queue が空になるまで WorkItem を claim し続ける 1 レーン分の処理。
 * 複数レーンを並走させることで `ANALYZER_WORKER_CONCURRENCY` 分の並列 claim を実現する。
 * @param prisma - Prisma クライアント
 * @param deps - kind ごとの処理関数一式
 */
async function drainLane(prisma: PrismaClient, deps: WorkerLoopDeps): Promise<void> {
  let hasMore = true
  while (hasMore) {
    hasMore = await runWorkerLoopOnce(prisma, deps)
  }
}

/**
 * queue にある WorkItem を空になるまで処理して終了する。継続的な実行は
 * entrypoint.sh 側の sleep ループ (crawler/blocker と同じ形) に委ねる。
 */
export async function main(): Promise<void> {
  const prisma = getPrismaClient()
  logger.info('analyzer starting')
  await prisma.$connect()

  // 起動時に記録しておかないと、queue が空で 1 件も処理しなかった期間の
  // System 画面が適用中 policy 不明のままになる。
  await recordPolicyVersion(prisma, loadPolicy(DEFAULT_POLICY_PATH))
  // 一意制約により、同じ日付分は 2 度目以降 no-op になる。
  await enqueueDailyRetentionSweep(prisma, new Date())
  // WorkItem 完了時のみだと、queue が空で何も処理しない期間は
  // 経過時間による delayed/stale への遷移を検出できない。
  await refreshReadModelFreshnessFromPolicy(prisma)

  const deps: WorkerLoopDeps = {
    leaseOwner: `${hostname()}-${process.pid}-${randomUUID()}`,
    processLabelMetrics,
    processFindingGeneration,
    processReadModelRefresh,
    processWeeklyReviewIngest,
    processBlockReconciliation,
    processRetentionSweep,
    onWorkItemSettled: handleWorkItemSettled,
  }

  const concurrency = getWorkerConcurrency()
  await Promise.all(Array.from({ length: concurrency }, () => drainLane(prisma, deps)))
  logger.info('analyzer finished: queue drained')
}

// このモジュールを import しただけでは実際の起動処理が走らないようにするガード。
// 直接実行 (`node dist/index.js`) した場合のみ動作する。require/module は、
// CommonJS を採用する本プロジェクトでこれを判定するのに適した手段である。
// eslint-disable-next-line unicorn/prefer-module
if (require.main === module) {
  initMonitoring()
  main()
    .catch((error: unknown) => {
      logger.error('analyzer failed', error as Error)
      captureException(error)
      process.exitCode = 1
    })
    .finally(() => disconnectPrisma())
}
