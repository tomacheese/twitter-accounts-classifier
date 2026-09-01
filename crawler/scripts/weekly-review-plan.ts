import { writeFile } from 'node:fs/promises'
import { PrismaClient } from '../generated/prisma'
import { generateWeeklyReviewPlan } from '../weekly-review/generate-review-plan'
import { PrismaWeeklyReviewPlanningDataSource } from '../weekly-review/prisma-review-plan-data-source'
import { PrismaWeeklyReviewRunPlanStore } from '../weekly-review/prisma-review-plan-run-store'
import { runWeeklyReviewPlanCli } from '../weekly-review/weekly-review-plan-cli'

export const PLANNING_TRANSACTION_TIMEOUT_MS = 120_000
export const PLANNING_TRANSACTION_MAX_WAIT_MS = 10_000

/**
 * planning transaction を実行する。sampling が読む read model のスナップショットを
 * RepeatableRead で固定しつつ、cold cache での実測時間を吸収できる timeout を与える。
 * @param prisma - transaction を発行する PrismaClient
 * @param fn - transaction 内で実行する処理
 * @returns fn の戻り値
 */
export function runPlanningTransaction<T>(
  prisma: PrismaClient,
  fn: (source: PrismaWeeklyReviewPlanningDataSource) => Promise<T>,
): Promise<T> {
  return prisma.$transaction((tx) => fn(new PrismaWeeklyReviewPlanningDataSource(tx)), {
    isolationLevel: 'RepeatableRead',
    timeout: PLANNING_TRANSACTION_TIMEOUT_MS,
    maxWait: PLANNING_TRANSACTION_MAX_WAIT_MS,
  })
}

async function main(): Promise<void> {
  const prisma = new PrismaClient()
  try {
    const store = new PrismaWeeklyReviewRunPlanStore(prisma)
    await runWeeklyReviewPlanCli(process.argv.slice(2), {
      generatePlan: (input) =>
        generateWeeklyReviewPlan(input, {
          store,
          runPlanningQuery: (fn) => runPlanningTransaction(prisma, fn),
        }),
      writeFile,
      print: console.log,
    })
  } finally {
    await prisma.$disconnect()
  }
}

// import だけでは CLI を起動しない。直接実行時のみ main を開始する。
// eslint-disable-next-line unicorn/prefer-module
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
