import type { PrismaClient } from '../generated/prisma'
import { getPrismaClient } from '../db/client'
import { buildOrUpdateCrawlCycle } from '../operations/build-crawl-cycle'

/**
 * phantom な read_model_refresh stage (work item was never enqueued による failed) を
 * 持つ crawl cycle の起点 CrawlRun ID 一覧を返す。
 * 実際に read_model_refresh を処理していた旧 pipeline の cycle は
 * analysisRunId が入っているため対象に含まれない。
 * 同じ cycle に label_aggregate_refresh の Stage が存在することも条件に含め、
 * 新 pipeline 移行後に作られた cycle だけを対象にする。
 * @param prisma - Prisma クライアント
 * @returns 対象 CrawlRun の ID 一覧
 */
export async function findPhantomCycleCrawlRunIds(prisma: PrismaClient): Promise<string[]> {
  const cycles = await prisma.operationCycle.findMany({
    where: {
      kind: 'crawl',
      stages: {
        some: {
          stageKey: 'read_model_refresh',
          status: 'failed',
          attemptCount: 0,
          errorSummary: 'work item was never enqueued',
        },
      },
      AND: {
        stages: { some: { stageKey: 'label_aggregate_refresh' } },
      },
    },
    select: { sourceId: true },
  })
  return cycles.map((cycle) => cycle.sourceId)
}

/**
 * read_model_refresh WorkItem の残存件数を status 別に集計する。
 * 0 件であれば processReadModelRefresh()/worker kind を別 Issue で削除できる。
 * @param prisma - Prisma クライアント
 * @returns status ごとの件数
 */
async function countReadModelRefreshWorkItems(
  prisma: PrismaClient,
): Promise<{ queued: number; leased: number; failed: number }> {
  const [queued, leased, failed] = await Promise.all([
    prisma.analysisWorkItem.count({ where: { kind: 'read_model_refresh', status: 'queued' } }),
    prisma.analysisWorkItem.count({ where: { kind: 'read_model_refresh', status: 'leased' } }),
    prisma.analysisWorkItem.count({ where: { kind: 'read_model_refresh', status: 'failed' } }),
  ])
  return { queued, leased, failed }
}

/**
 * backfill 本体。dry-run では対象一覧のログのみ出力し、apply では実際に再構築する。
 * @param prisma - Prisma クライアント
 * @param apply - true なら実際に buildOrUpdateCrawlCycle を実行する
 * @returns 補正後もなお phantom stage が残る CrawlRun の ID 一覧
 */
export async function runBackfill(prisma: PrismaClient, apply: boolean): Promise<string[]> {
  const targetCrawlRunIds = await findPhantomCycleCrawlRunIds(prisma)
  console.log(
    `[backfill] phantom read_model_refresh stage を持つ crawl cycle: ${targetCrawlRunIds.length} 件`,
  )
  for (const crawlRunId of targetCrawlRunIds) {
    console.log(`[backfill] target crawlRunId=${crawlRunId}`)
  }

  const workItemCounts = await countReadModelRefreshWorkItems(prisma)
  console.log(
    `[backfill] read_model_refresh WorkItem 残存件数: queued=${workItemCounts.queued} leased=${workItemCounts.leased} failed=${workItemCounts.failed}`,
  )

  if (!apply) {
    console.log(
      '[backfill] dry-run のため書き込みは行わない。--apply を付けて再実行すると補正する。',
    )
    return targetCrawlRunIds
  }

  for (const crawlRunId of targetCrawlRunIds) {
    await buildOrUpdateCrawlCycle(prisma, { crawlRunId })
  }

  const remaining = await findPhantomCycleCrawlRunIds(prisma)
  if (remaining.length > 0) {
    console.error(
      `[backfill] 補正後も phantom read_model_refresh stage が残っている: ${remaining.length} 件`,
    )
    for (const crawlRunId of remaining) {
      console.error(`[backfill] remaining crawlRunId=${crawlRunId}`)
    }
  } else {
    console.log('[backfill] phantom read_model_refresh stage はすべて解消された。')
  }
  return remaining
}

/**
 * CLI エントリポイント。
 */
async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const prisma = getPrismaClient()
  const remaining = await runBackfill(prisma, apply)
  if (apply && remaining.length > 0) {
    process.exitCode = 1
  }
}

// eslint-disable-next-line unicorn/prefer-module
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
