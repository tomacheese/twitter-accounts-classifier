import { Logger } from '@book000/node-utils'
import { getPrismaClient, disconnectPrisma } from '../db/client'
import { runRetentionSweep } from '../retention/sweep'

const logger = Logger.configure('analyzer:retention-sweep-script')

// 既定は dry-run で、削除対象の行数だけを表示する。実際に削除するときだけ --execute を付ける。
// 本番では `docker compose run --rm analyzer node dist/scripts/retention-sweep.js [--execute]` を使う。
async function main(): Promise<void> {
  const dryRun = !process.argv.includes('--execute')
  const prisma = getPrismaClient()
  await prisma.$connect()

  const result = await runRetentionSweep(prisma, new Date(), { dryRun })
  for (const [name, count] of Object.entries(result.counts)) {
    logger.info(`${name}: ${count} row(s) ${dryRun ? 'to delete' : 'deleted'}`)
  }
  if (result.truncatedTables.length > 0) {
    logger.info(`more rows remain (batch limit reached): ${result.truncatedTables.join(', ')}`)
  }
  if (dryRun) logger.info('dry-run: pass --execute to delete')
}

// eslint-disable-next-line unicorn/prefer-module
if (require.main === module) {
  main()
    .catch((error: unknown) => {
      logger.error('retention sweep failed', error as Error)
      process.exitCode = 1
    })
    .finally(() => disconnectPrisma())
}
