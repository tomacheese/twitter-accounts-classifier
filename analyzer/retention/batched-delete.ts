import { setTimeout as sleep } from 'node:timers/promises'
import { Prisma, type PrismaClient } from '../generated/prisma'

export interface BatchedDeleteOptions {
  /** 対象テーブル名。識別子を SQL へ埋め込むため、呼び出し側の定数だけを渡す。 */
  table: string
  /** 主キーの列名。複合キーも指定できる。 */
  keyColumns: readonly string[]
  /** 削除対象の述語。対象テーブルはエイリアス `t` で参照する。 */
  where: Prisma.Sql
  batchSize: number
  /** 実行するバッチ数の上限。上限に達した残りは次回の実行に持ち越す。 */
  maxBatches: number
  pauseMs: number
  /** true のとき削除せず、上限までの対象行数だけを数える。 */
  dryRun: boolean
}

export interface BatchedDeleteResult {
  /** 削除した行数 (dryRun では削除対象の行数。上限で打ち切る)。 */
  count: number
  /** 上限に達し、対象行がまだ残っている可能性がある。 */
  hasMore: boolean
}

function quote(identifier: string): Prisma.Sql {
  return Prisma.raw(`"${identifier.replaceAll('"', '""')}"`)
}

/**
 * 述語に合う行を、1 文あたり batchSize 行までの小さな DELETE に分けて削除する。
 * 述語は毎回評価し直すため、中断しても再実行すれば続きから進み、二度実行しても結果は変わらない。
 * @returns 削除した行数と、上限で打ち切ったかどうか
 */
export async function deleteInBatches(
  prisma: PrismaClient,
  options: BatchedDeleteOptions,
): Promise<BatchedDeleteResult> {
  const table = quote(options.table)
  const keys = Prisma.join(options.keyColumns.map((column) => quote(column)))
  const tKeys = Prisma.join(options.keyColumns.map((column) => Prisma.sql`t.${quote(column)}`))
  const cap = options.batchSize * options.maxBatches

  if (options.dryRun) {
    const rows = await prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM (
        SELECT 1 FROM ${table} t WHERE ${options.where} LIMIT ${cap}
      ) sample`
    const count = rows[0]?.count ?? 0
    return { count, hasMore: count >= cap }
  }

  let total = 0
  for (let batch = 0; batch < options.maxBatches; batch++) {
    const deleted = await prisma.$executeRaw`
      DELETE FROM ${table}
      WHERE (${keys}) IN (
        SELECT ${tKeys} FROM ${table} t WHERE ${options.where} LIMIT ${options.batchSize}
      )`
    total += deleted
    if (deleted < options.batchSize) return { count: total, hasMore: false }
    await sleep(options.pauseMs)
  }
  return { count: total, hasMore: true }
}
