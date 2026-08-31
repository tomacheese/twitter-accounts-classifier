import { writeFile } from 'node:fs/promises'
import { PrismaClient } from '../generated/prisma'
import { generateWeeklyReviewPlan } from '../weekly-review/generate-review-plan'
import { PrismaWeeklyReviewPlanningDataSource } from '../weekly-review/prisma-review-plan-data-source'
import { PrismaWeeklyReviewRunPlanStore } from '../weekly-review/prisma-review-plan-run-store'
import { runWeeklyReviewPlanCli } from '../weekly-review/weekly-review-plan-cli'

const PLANNING_TRANSACTION_TIMEOUT_MS = 60_000
const PLANNING_TRANSACTION_MAX_WAIT_MS = 10_000

async function main(): Promise<void> {
  const prisma = new PrismaClient()
  try {
    const store = new PrismaWeeklyReviewRunPlanStore(prisma)
    await runWeeklyReviewPlanCli(process.argv.slice(2), {
      generatePlan: (input) =>
        generateWeeklyReviewPlan(input, {
          store,
          runPlanningQuery: (fn) =>
            prisma.$transaction((tx) => fn(new PrismaWeeklyReviewPlanningDataSource(tx)), {
              isolationLevel: 'RepeatableRead',
              timeout: PLANNING_TRANSACTION_TIMEOUT_MS,
              maxWait: PLANNING_TRANSACTION_MAX_WAIT_MS,
            }),
        }),
      writeFile,
      print: console.log,
    })
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
