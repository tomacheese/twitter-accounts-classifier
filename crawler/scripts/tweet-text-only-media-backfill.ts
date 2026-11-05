import { Prisma, type PrismaClient } from '../generated/prisma'
import { getPrismaClient, disconnectPrisma } from '../db/client'

export interface TweetKey {
  accountId: string
  id: string
}

export interface TextOnlyBackfillOptions {
  foreignVideoSince: Date
  hasMediaSince: Date
  /** 前回の最後の位置。Tweet の PK の並び (accountId, id) で再開する。 */
  after?: TweetKey
  batchSize: number
  sleepMs: number
  maxBatches?: number
  execute: boolean
}

export interface TextOnlyBackfillDependencies {
  prisma: PrismaClient
  sleep: (ms: number) => Promise<void>
  log: (message: string) => void
}

const PROGRESS_LOG_INTERVAL = 100

function formatKey(key: TweetKey): string {
  return `${key.accountId}:${key.id}`
}

function parseDate(args: string[], name: string): Date {
  const index = args.indexOf(name)
  const parsed = index === -1 ? Number.NaN : Date.parse(args.at(index + 1) ?? '')
  if (Number.isNaN(parsed)) throw new Error(`${name} must be an ISO timestamp`)
  return new Date(parsed)
}

function parsePositiveInt(args: string[], name: string, defaultValue?: number): number | undefined {
  const index = args.indexOf(name)
  if (index === -1) return defaultValue
  const raw = args.at(index + 1) ?? ''
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive integer`)
  return Number(raw)
}

/**
 * 既定は dry-run で、先頭 1 window の件数だけを数える。書き込みは `--execute` を明示した場合に限る。
 * 取り込み時刻の境界は、判定仕様が変わった時点に依存するため必ず明示させる。
 * @param args - CLI 引数
 * @returns 解釈済みオプション
 */
export function parseTextOnlyBackfillArgs(args: string[]): TextOnlyBackfillOptions {
  const execute = args.includes('--execute')
  const afterIndex = args.indexOf('--after-key')
  const afterKey = afterIndex === -1 ? undefined : args.at(afterIndex + 1)
  if (afterKey !== undefined && !/^\d+:\d+$/.test(afterKey)) {
    throw new Error('--after-key must be <accountId>:<tweetId>')
  }
  const [afterAccountId, afterTweetId] = afterKey?.split(':') ?? []
  return {
    foreignVideoSince: parseDate(args, '--foreign-video-since'),
    hasMediaSince: parseDate(args, '--has-media-since'),
    after: afterKey === undefined ? undefined : { accountId: afterAccountId, id: afterTweetId },
    batchSize: parsePositiveInt(args, '--batch-size', 5000) ?? 5000,
    sleepMs: parsePositiveInt(args, '--sleep-ms', 100) ?? 100,
    maxBatches: parsePositiveInt(args, '--max-batches', execute ? undefined : 1),
    execute,
  }
}

/**
 * 動画・画像のない投稿で NULL のまま残っている `foreignVideoSourceCount` と `hasMedia` を確定値へ埋める。
 * 各列の判定が収集に入る前の行は本当に未評価なので、列ごとの取り込み時刻の境界以降の行だけを対象にする。
 * 冪等で、進捗ログの `lastKey` を `--after-key` に渡して再開できる。
 * @param options - 実行オプション
 * @param deps - 依存関係
 */
export async function runTextOnlyMediaBackfill(
  options: TextOnlyBackfillOptions,
  deps: TextOnlyBackfillDependencies,
): Promise<void> {
  const { prisma } = deps
  let after: TweetKey = options.after ?? { accountId: '0', id: '0' }
  let batches = 0
  let scanned = 0
  let candidates = 0
  let updated = 0

  while (options.maxBatches === undefined || batches < options.maxBatches) {
    // 走査と更新の対象指定は PK の形 (accountId, id) に依存する。RANGE 版 (PK は id のみ) へ切り替えるときはここを書き換える。
    // ORDER BY は出力の別名 (text) ではなく列そのものを指すよう、表名で修飾する。
    const window = await prisma.$queryRaw<TweetKey[]>(Prisma.sql`
      SELECT "accountId"::text AS "accountId", "id"::text AS "id" FROM "Tweet"
      WHERE ("accountId", "id") > (${after.accountId}::bigint, ${after.id}::bigint)
      ORDER BY "Tweet"."accountId", "Tweet"."id" LIMIT ${options.batchSize}
    `)
    if (window.length === 0) break
    const ids = window.map((row) => row.id)
    const accountIds = window.map((row) => row.accountId)
    after = window.at(-1) ?? after
    scanned += ids.length
    batches += 1

    if (options.execute) {
      updated += await prisma.$executeRaw(Prisma.sql`
        UPDATE "Tweet" SET
          "foreignVideoSourceCount" = 0,
          "hasMedia" = CASE
            WHEN "collectedAt" >= ${options.hasMediaSince} AND "hasMedia" IS NULL THEN false
            ELSE "hasMedia"
          END
        WHERE ("accountId", "id") IN (SELECT * FROM UNNEST(${accountIds}::bigint[], ${ids}::bigint[]))
          AND "foreignVideoSourceCount" IS NULL
          AND "collectedAt" >= ${options.foreignVideoSince}
      `)
      await deps.sleep(options.sleepMs)
      if (batches % PROGRESS_LOG_INTERVAL === 0) {
        deps.log(
          JSON.stringify({ progress: true, batches, scanned, updated, lastKey: formatKey(after) }),
        )
      }
    } else {
      const [row] = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
        SELECT count(*) AS "count" FROM "Tweet"
        WHERE ("accountId", "id") IN (SELECT * FROM UNNEST(${accountIds}::bigint[], ${ids}::bigint[]))
          AND "foreignVideoSourceCount" IS NULL
          AND "collectedAt" >= ${options.foreignVideoSince}
      `)
      candidates += Number(row.count)
    }
  }

  deps.log(
    JSON.stringify({
      mode: options.execute ? 'execute' : 'dry-run',
      batches,
      scanned,
      ...(options.execute ? { updated } : { candidates }),
      lastKey: after.id === '0' ? undefined : formatKey(after),
    }),
  )
}

async function main(): Promise<void> {
  const prisma = getPrismaClient()
  try {
    await runTextOnlyMediaBackfill(parseTextOnlyBackfillArgs(process.argv.slice(2)), {
      prisma,
      sleep: (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms)
        }),
      log: console.log,
    })
  } finally {
    await disconnectPrisma()
  }
}

// import.meta ではなく require/module を使う: このプロジェクトは CommonJS であるため。
// eslint-disable-next-line unicorn/prefer-module
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
