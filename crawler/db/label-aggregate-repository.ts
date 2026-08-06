import { Logger } from '@book000/node-utils'
import type { PrismaClient } from '../generated/prisma'
import { captureException } from '../monitoring/sentry'

const logger = Logger.configure('label-aggregate-repository')

export interface LabelAggregateDistributionEntry {
  labelDefinitionId: string
  labelKey: string
  labelDescription: string
  trueCount: number
  totalCount: number
}

export interface LabelAggregateComputeResult {
  labeledAccounts: number
  distribution: LabelAggregateDistributionEntry[]
}

// json_agg() が返す distribution の要素はすでに JSON としてパース済みのため、
// trueCount/totalCount はここでは(直接の bigint 列とは異なり)number で届く。
interface LabelAggregateDistributionJsonRow {
  labelDefinitionId: string
  labelKey: string
  labelDescription: string
  trueCount: number
  totalCount: number
}

interface LabelAggregateSnapshotRow {
  labeledAccounts: bigint
  distribution: LabelAggregateDistributionJsonRow[]
}

/**
 * AccountLabelLatest を集計し、ラベル付けずみアカウント数とラベル定義ごとの
 * 分布を返す。viewer 側のリクエスト経路からこの Seq Scan を完全に排除するため、
 * この関数は crawler プロセスからのみ呼び出す。
 * AccountLabelLatest の設計意図は prisma/schema.prisma の該当コメントを参照。
 * statement_timeout は、この SQL がクロールバッチ処理内でのみ実行される
 * 一回限りのクエリになったことを踏まえ、プロセス全体が無応答のまま
 * 張り付き続けるのを防ぐガードレールとして設定している。
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns ラベル付けずみアカウント数とラベル定義ごとの分布
 */
export async function computeLabelAggregateSnapshot(
  prisma: PrismaClient,
): Promise<LabelAggregateComputeResult> {
  const result = await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL statement_timeout = '300000'`,
    prisma.$queryRaw<LabelAggregateSnapshotRow[]>`
      WITH latest_labels AS NOT MATERIALIZED (
        SELECT "accountId", "labelDefinitionId", "value"
        FROM "AccountLabelLatest"
      ),
      label_counts AS (
        SELECT
          ld.id AS "labelDefinitionId",
          ld.key AS "labelKey",
          ld.description AS "labelDescription",
          COALESCE(COUNT(*) FILTER (WHERE ll.value), 0) AS "trueCount",
          COALESCE(COUNT(ll."accountId"), 0) AS "totalCount"
        FROM "LabelDefinition" ld
        LEFT JOIN latest_labels ll ON ll."labelDefinitionId" = ld.id
        GROUP BY ld.id, ld.key, ld.description
      )
      SELECT
        (SELECT COUNT(DISTINCT "accountId") FROM latest_labels WHERE "value" = true) AS "labeledAccounts",
        (
          SELECT COALESCE(json_agg(lc.* ORDER BY lc."labelKey"), '[]'::json)
          FROM label_counts lc
        ) AS distribution
    `,
  ])
  const rows = result[1]

  // トップレベルの SELECT に FROM 句がなく常に1行だけ返るが、
  // Prisma の $queryRaw の戻り値の型は配列であり要素数を型では保証できないため、
  // Array#at() で undefined を許容する型のまま安全に取り出す。
  const row = rows.at(0)
  return {
    labeledAccounts: Number(row?.labeledAccounts ?? 0),
    distribution: (row?.distribution ?? []).map((entry) => ({
      labelDefinitionId: entry.labelDefinitionId,
      labelKey: entry.labelKey,
      labelDescription: entry.labelDescription,
      trueCount: entry.trueCount,
      totalCount: entry.totalCount,
    })),
  }
}

const STATUS_ID = 'global'

// viewer 側 (viewer/lib/queries/dashboard.ts) にも同じ ID の固定行を
// 参照する定義があり、この値は両者で一致させ続ける必要がある。
type LabelAggregateAttemptStatus = 'success' | 'failed'

// error.message にはドライバー由来の接続情報などが含まれうるため、
// viewer/app/labels/page.tsx が既存で採っている方針と同様、
// DB へ永続化する値には汎用メッセージのみを残し、詳細はログ・Sentry にのみ出す。
const GENERIC_FAILURE_MESSAGE = 'Failed to refresh label aggregate. See crawler logs for details.'

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * LabelAggregateStatus を失敗状態で upsert する。この upsert 自体が失敗した場合、
 * 呼び出し元の catch を素通りさせると元のエラーの文脈が失われるため、
 * ここで自前にログ・Sentry送出まで完結させる。
 * @param prisma - クエリを実行する Prisma クライアント
 * @param now - 記録する試行時刻
 * @param error - 記録対象の失敗の原因
 */
async function markAttemptFailed(prisma: PrismaClient, now: Date, error: unknown): Promise<void> {
  const rawMessage = toErrorMessage(error)
  logger.error('Failed to refresh label aggregate.', error as Error)
  captureException(error, { source: 'refreshLabelAggregate' })

  try {
    await prisma.labelAggregateStatus.upsert({
      where: { id: STATUS_ID },
      create: {
        id: STATUS_ID,
        labeledAccounts: 0,
        lastSuccessAt: null,
        lastAttemptAt: now,
        lastAttemptStatus: 'failed' satisfies LabelAggregateAttemptStatus,
        lastErrorMessage: GENERIC_FAILURE_MESSAGE,
      },
      update: {
        lastAttemptAt: now,
        lastAttemptStatus: 'failed' satisfies LabelAggregateAttemptStatus,
        lastErrorMessage: GENERIC_FAILURE_MESSAGE,
      },
    })
  } catch (statusError) {
    logger.error(
      `Failed to record label aggregate failure status. originalError: ${rawMessage}`,
      statusError as Error,
    )
    captureException(statusError, {
      source: 'refreshLabelAggregate.markAttemptFailed',
      originalError: rawMessage,
    })
  }
}

/**
 * computeLabelAggregateSnapshot を呼び、成功すれば LabelAggregate を
 * 事前計算結果へ更新し、LabelAggregateStatus を成功状態で upsert する。
 * 失敗時は LabelAggregate に一切書き込まず、LabelAggregateStatus のみ
 * 失敗状態で upsert する (前回成功時点の LabelAggregate はそのまま残る)。
 * 書き込みは行単位の upsert とし、全削除してからの全件挿入にしていないのは、
 * crawl.ts と relabel.ts から並行に呼ばれた場合、削除後・挿入前の空白時間に
 * 一意制約違反を起こさずに済ませるため。
 * @param prisma - クエリを実行する Prisma クライアント
 */
export async function refreshLabelAggregate(prisma: PrismaClient): Promise<void> {
  const now = new Date()
  let snapshot: LabelAggregateComputeResult
  try {
    snapshot = await computeLabelAggregateSnapshot(prisma)
  } catch (error) {
    await markAttemptFailed(prisma, now, error)
    return
  }

  const currentLabelDefinitionIds = snapshot.distribution.map((entry) => entry.labelDefinitionId)

  try {
    await prisma.$transaction([
      ...snapshot.distribution.map((entry) =>
        prisma.labelAggregate.upsert({
          where: { labelDefinitionId: entry.labelDefinitionId },
          create: {
            labelDefinitionId: entry.labelDefinitionId,
            labelKey: entry.labelKey,
            labelDescription: entry.labelDescription,
            trueCount: entry.trueCount,
            totalCount: entry.totalCount,
            updatedAt: now,
          },
          update: {
            labelKey: entry.labelKey,
            labelDescription: entry.labelDescription,
            trueCount: entry.trueCount,
            totalCount: entry.totalCount,
            updatedAt: now,
          },
        }),
      ),
      // ラベル定義が削除された場合の孤児行を掃除する。Prisma の notIn: [] は
      // 「全件不一致」として扱われ全行削除相当になるため、
      // 現在のラベル定義がゼロ件の場合だけ deleteMany({}) に分けて明示する。
      currentLabelDefinitionIds.length > 0
        ? prisma.labelAggregate.deleteMany({
            where: { labelDefinitionId: { notIn: currentLabelDefinitionIds } },
          })
        : prisma.labelAggregate.deleteMany({}),
      prisma.labelAggregateStatus.upsert({
        where: { id: STATUS_ID },
        create: {
          id: STATUS_ID,
          labeledAccounts: snapshot.labeledAccounts,
          lastSuccessAt: now,
          lastAttemptAt: now,
          lastAttemptStatus: 'success' satisfies LabelAggregateAttemptStatus,
          lastErrorMessage: null,
        },
        update: {
          labeledAccounts: snapshot.labeledAccounts,
          lastSuccessAt: now,
          lastAttemptAt: now,
          lastAttemptStatus: 'success' satisfies LabelAggregateAttemptStatus,
          lastErrorMessage: null,
        },
      }),
    ])
  } catch (error) {
    await markAttemptFailed(prisma, now, error)
  }
}
