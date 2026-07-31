// The default (output-less) generator location is unreachable from this file's
// package context in the pnpm workspace split (see prisma/schema.prisma's comment on
// the `client` generator) — import the crawler's generated client explicitly instead.
import { PrismaClient } from '../crawler/generated/prisma'
import { ensureLabelDefinitionsForRules } from '../crawler/db/label-repository'
import { ALL_LABEL_RULES } from '../crawler/labels/all-rules'

const prisma = new PrismaClient()

async function main() {
  await ensureLabelDefinitionsForRules(prisma, ALL_LABEL_RULES)
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
