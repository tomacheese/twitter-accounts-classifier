import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { Logger } from '@book000/node-utils'
import { getPrismaClient, disconnectPrisma } from './db/client'
import { runWorkerLoopOnce, type WorkerLoopDeps } from './worker-loop'
import {
  processLabelMetrics,
  processFindingGeneration,
  processReadModelRefresh,
  processWeeklyReviewIngest,
  processBlockReconciliation,
} from './worker-processors'
import { getWorkerConcurrency } from './config/env'
import type { PrismaClient } from './generated/prisma'

const logger = Logger.configure('analyzer')

/**
 * queue が空になるまで WorkItem を claim し続ける 1 レーン分の処理。
 * 複数レーンを並走させることで `ANALYZER_WORKER_CONCURRENCY` 分の並列 claim を実現する。
 * @param prisma - Prisma クライアント
 * @param deps - kind ごとの処理関数一式
 */
async function drainLane(prisma: PrismaClient, deps: WorkerLoopDeps): Promise<void> {
  while (await runWorkerLoopOnce(prisma, deps)) {
    // 戻り値 true の間は queue に処理対象が残っているため、次の 1 件へ進む。
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

  const deps: WorkerLoopDeps = {
    leaseOwner: `${hostname()}-${process.pid}-${randomUUID()}`,
    processLabelMetrics,
    processFindingGeneration,
    processReadModelRefresh,
    processWeeklyReviewIngest,
    processBlockReconciliation,
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
  main()
    .catch((error: unknown) => {
      logger.error('analyzer failed', error as Error)
      process.exitCode = 1
    })
    .finally(() => disconnectPrisma())
}
