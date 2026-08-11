import { writeFile } from 'node:fs/promises'
import { PrismaClient } from '../generated/prisma'
import { generateWeeklyReviewPlan } from '../weekly-review/generate-review-plan'
import { PrismaWeeklyReviewPlanningDataSource } from '../weekly-review/prisma-review-plan-data-source'
import { PrismaWeeklyReviewRunPlanStore } from '../weekly-review/prisma-review-plan-run-store'
import { runWeeklyReviewPlanCli } from '../weekly-review/weekly-review-plan-cli'

async function main(): Promise<void> {
  const prisma = new PrismaClient()
  try {
    const store = new PrismaWeeklyReviewRunPlanStore(prisma)
    const source = new PrismaWeeklyReviewPlanningDataSource(prisma)
    await runWeeklyReviewPlanCli(process.argv.slice(2), {
      generatePlan: (input) => generateWeeklyReviewPlan(input, { store, source }),
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
