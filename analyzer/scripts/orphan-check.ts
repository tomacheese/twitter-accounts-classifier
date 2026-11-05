import { Logger } from '@book000/node-utils'
import { getPrismaClient, disconnectPrisma } from '../db/client'
import {
  ORPHAN_CHECK_TABLES,
  runOrphanCheck,
  type OrphanCheckTable,
} from '../retention/orphan-check'

const logger = Logger.configure('analyzer:orphan-check-script')

/**
 * @param name - 引数名 (`--name=value` の name)
 * @returns 指定された値の一覧
 */
function argValues(name: string): string[] {
  const prefix = `--${name}=`
  return process.argv.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length))
}

/**
 * @param value - 表名
 * @returns 検査対象の表名
 */
function toTable(value: string): OrphanCheckTable {
  const table = ORPHAN_CHECK_TABLES.find((candidate) => candidate === value)
  if (!table) {
    throw new Error(`unknown table "${value}"; expected one of ${ORPHAN_CHECK_TABLES.join(', ')}`)
  }
  return table
}

// 読み取りだけを行う。孤児があれば終了コード 1、検査を打ち切ったときは続きの位置を表示する。
//   --table=Tweet            検査する表 (複数指定可。既定は全表)
//   --resume=Tweet:123456    表ごとの再開位置 (前回の nextCursor)
//   --max-batches=100        表ごとに読むバッチ数の上限
async function main(): Promise<void> {
  const tables = argValues('table').map((value) => toTable(value))
  const resumeFrom: Partial<Record<OrphanCheckTable, string>> = {}
  for (const entry of argValues('resume')) {
    const [table, cursor] = entry.split(':')
    if (!cursor || !/^\d+$/.test(cursor)) {
      throw new Error(`invalid --resume value "${entry}"; expected <Table>:<accountId>`)
    }
    resumeFrom[toTable(table)] = cursor
  }
  const maxBatchesArg = argValues('max-batches').at(0)
  const maxBatchesPerTable = maxBatchesArg === undefined ? undefined : Number(maxBatchesArg)
  if (maxBatchesPerTable !== undefined && !Number.isInteger(maxBatchesPerTable)) {
    throw new TypeError(`invalid --max-batches value "${maxBatchesArg}"`)
  }

  const prisma = getPrismaClient()
  await prisma.$connect()
  const results = await runOrphanCheck(prisma, {
    tables: tables.length > 0 ? tables : undefined,
    resumeFrom,
    maxBatchesPerTable,
  })

  for (const result of results) {
    logger.info(
      `${result.table}: scanned ${result.scannedRows} row(s), ` +
        `${result.orphanAccountCount} orphan account(s) / ${result.orphanRowCount} orphan row(s)` +
        (result.sampleAccountIds.length > 0 ? ` e.g. ${result.sampleAccountIds.join(',')}` : '') +
        (result.nextCursor === null
          ? ''
          : `; stopped early, resume with --resume=${result.table}:${result.nextCursor}`),
    )
  }
  if (results.some((result) => result.orphanAccountCount > 0)) process.exitCode = 1
}

// eslint-disable-next-line unicorn/prefer-module
if (require.main === module) {
  main()
    .catch((error: unknown) => {
      logger.error('orphan check failed', error as Error)
      process.exitCode = 1
    })
    .finally(() => disconnectPrisma())
}
