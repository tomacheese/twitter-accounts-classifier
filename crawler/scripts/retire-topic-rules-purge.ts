import type { PrismaClient } from '../generated/prisma'
import { parsePositiveIntEnv } from '../config/env'
import { getPrismaClient, disconnectPrisma } from '../db/client'

export const RETIRED_TOPIC_LABEL_KEYS = [
  'topic_anime',
  'topic_beauty',
  'topic_crypto',
  'topic_finance',
  'topic_fitness',
  'topic_food',
  'topic_gaming',
  'topic_idol',
  'topic_illustration',
  'topic_movie',
  'topic_music',
  'topic_nsfw',
  'topic_parenting',
  'topic_pets',
  'topic_politics',
  'topic_sports',
  'topic_tech',
  'topic_travel',
  'topic_vrchat',
  'topic_vtuber',
] as const

/**
 * `labelDefinitionId` を持つテーブルを、子→親、行テーブル→集計テーブルの順に並べたもの。
 * 集計テーブルは行テーブルのトリガーが decrement するため、行テーブルを先に空にしてから消す。
 */
export const PURGE_TABLES = [
  'BlockAction',
  'BlockOutboxEntry',
  'AccountLabelChange',
  'AccountClassificationLatest',
  'AccountLabelLatest',
  'CrawlAccountLabelRun',
  'WeeklyReviewSampleBucketCount',
  'AccountClassificationValueCount',
  'AccountClassificationConfidenceBucketCount',
  'AccountClassificationRuleVersionCount',
  'AccountClassificationFreshnessBucket',
  'AccountClassificationReasonCount',
  'LabelMetricSnapshot',
  'LabelMetricDaily',
  'LabelSummaryCurrent',
] as const

/**
 * マイグレーションから作られた DB にだけ残る旧テーブル。`LabelDefinition` を外部キーで参照するため、存在する場合のみ削除する。
 * 本番など、すでに取り除かれている DB には存在しない。
 */
export const OPTIONAL_PURGE_TABLES = ['AccountLabel_pre_compaction'] as const

type PurgeTable = (typeof PURGE_TABLES)[number] | (typeof OPTIONAL_PURGE_TABLES)[number]

export interface PurgeOptions {
  batchSize: number
  sleepMs: number
}

export interface PurgeDependencies {
  prisma: PrismaClient
  options: PurgeOptions
  sleep: (ms: number) => Promise<void>
  log: (message: string) => void
}

/**
 * 1 回の `DELETE`/`UPDATE` を小さな batch に分け、各 batch を独立した transaction として commit する。
 * 1 transaction で全行を消すと、行ごとのトリガーと WAL でタイムアウトや長時間ロックを招くため。
 * @param deps - 実行に使う依存
 * @param run - 1 batch を実行し、影響を受けた行数を返す関数
 * @returns 影響を受けた行数の合計
 */
async function runBatches(deps: PurgeDependencies, run: () => Promise<number>): Promise<number> {
  let total = 0
  for (;;) {
    const affected = await run()
    if (affected === 0) return total
    total += affected
    await deps.sleep(deps.options.sleepMs)
  }
}

/**
 * `labelDefinitionId` を持つテーブルが、purge 対象で漏れなく覆われているか確認する。
 * スキーマに後から足されたテーブルの孤立行を、静かに残さないため。
 * @param prisma - Prisma クライアント
 * @returns 削除対象のテーブル。`PURGE_TABLES` の後ろに、存在する `OPTIONAL_PURGE_TABLES` を続けたもの
 */
async function resolvePurgeTables(prisma: PrismaClient): Promise<PurgeTable[]> {
  const rows = await prisma.$queryRawUnsafe<{ tableName: string }[]>(
    `SELECT DISTINCT table_name AS "tableName" FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'labelDefinitionId'`,
  )
  const present = new Set(rows.map((row) => row.tableName))
  const known = new Set<string>([...PURGE_TABLES, ...OPTIONAL_PURGE_TABLES])
  const uncovered = [...present].filter((name) => !known.has(name))
  if (uncovered.length > 0) {
    throw new Error(
      `Tables with labelDefinitionId are not covered by the purge: ${uncovered.join(', ')}`,
    )
  }
  return [...PURGE_TABLES, ...OPTIONAL_PURGE_TABLES.filter((table) => present.has(table))]
}

async function deleteBatch(
  prisma: PrismaClient,
  table: PurgeTable,
  labelDefinitionIds: string[],
  batchSize: number,
): Promise<number> {
  // table は PURGE_TABLES の固定値のみで、外部入力は含まない。
  return prisma.$executeRawUnsafe(
    `DELETE FROM "${table}" WHERE ctid = ANY(ARRAY(
       SELECT ctid FROM "${table}" WHERE "labelDefinitionId" = ANY($1::text[]) LIMIT $2::int
     ))`,
    labelDefinitionIds,
    batchSize,
  )
}

async function cleanActiveLabelKeysBatch(
  prisma: PrismaClient,
  keys: string[],
  batchSize: number,
): Promise<number> {
  return prisma.$executeRawUnsafe(
    `UPDATE "AccountSummaryLatest" SET
       "activeLabelKeys" = ARRAY(SELECT k FROM unnest("activeLabelKeys") AS k WHERE k <> ALL($1::text[])),
       "activeLabelCount" = cardinality(ARRAY(SELECT k FROM unnest("activeLabelKeys") AS k WHERE k <> ALL($1::text[])))
     WHERE "accountId" = ANY(ARRAY(
       SELECT "accountId" FROM "AccountSummaryLatest" WHERE "activeLabelKeys" && $1::text[] LIMIT $2::int
     ))`,
    keys,
    batchSize,
  )
}

/**
 * 廃止した topic_* ラベルのデータを、小さな batch で削除する。冪等で、中断しても再実行できる。
 * 旧バージョンの crawler / relabel-worker / analyzer が動いていると行が再作成されるため、停止してから実行すること。
 * @param deps - 実行に使う依存
 */
export async function runRetireTopicRulesPurge(deps: PurgeDependencies): Promise<void> {
  const { prisma, options, log } = deps
  const tables = await resolvePurgeTables(prisma)

  const definitions = await prisma.labelDefinition.findMany({
    where: { key: { in: [...RETIRED_TOPIC_LABEL_KEYS] } },
    select: { id: true },
  })
  const labelDefinitionIds = definitions.map((definition) => definition.id)
  const keys = [...RETIRED_TOPIC_LABEL_KEYS]

  for (const table of tables) {
    const deleted = await runBatches(deps, () =>
      deleteBatch(prisma, table, labelDefinitionIds, options.batchSize),
    )
    log(`Purged ${deleted} rows from ${table}`)
  }

  // activeLabelCount は activeLabelKeys の要素数と一致させる。
  // counter trigger が 0 跨ぎで LabeledAccountCounter を更新するため、同じ UPDATE で書き換える。
  const updated = await runBatches(deps, () =>
    cleanActiveLabelKeysBatch(prisma, keys, options.batchSize),
  )
  log(`Removed retired keys from ${updated} rows of AccountSummaryLatest`)

  // 外部キーが残っていれば RESTRICT で失敗する。これは削除漏れの検知を兼ねる。
  const removed = await prisma.$executeRawUnsafe(
    `DELETE FROM "LabelDefinition" WHERE id = ANY($1::text[])`,
    labelDefinitionIds,
  )
  log(`Deleted ${removed} rows from LabelDefinition`)
}

async function main(): Promise<void> {
  const prisma = getPrismaClient()
  try {
    await runRetireTopicRulesPurge({
      prisma,
      options: {
        batchSize: parsePositiveIntEnv('RETIRE_TOPIC_PURGE_BATCH_SIZE', 5000),
        sleepMs: parsePositiveIntEnv('RETIRE_TOPIC_PURGE_SLEEP_MS', 100),
      },
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
