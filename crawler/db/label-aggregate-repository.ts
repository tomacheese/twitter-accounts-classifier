import type { PrismaClient } from '../generated/prisma'

export interface LabelAggregateDistributionEntry {
  labelDefinitionId: string
  labelKey: string
  labelDescription: string
  trueCount: number
  totalCount: number
}

export interface LabelAggregateSnapshot {
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
 * viewer/lib/queries/dashboard.ts の旧 queryLatestLabelsSummary と同じ CTE 構成で
 * AccountLabelLatest を集計する。viewer 側のリクエスト経路からこの Seq Scan を
 * 完全に排除するため、この関数は crawler プロセスからのみ呼び出す。
 * statement_timeout は、クエリが詰まった場合にプールの枠を占有し続けて枯渇を招くのを
 * 防ぐために設定している (`AccountLabelLatest` の設計意図は prisma/schema.prisma の
 * 該当コメントを参照)。
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns ラベル付けずみアカウント数とラベル定義ごとの分布
 */
export async function computeLabelAggregateSnapshot(
  prisma: PrismaClient,
): Promise<LabelAggregateSnapshot> {
  const result = await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL statement_timeout = '60000'`,
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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * computeLabelAggregateSnapshot を呼び、成功すれば LabelAggregate の全行を
 * 事前計算結果へ置き換え、LabelAggregateStatus を成功状態で upsert する。
 * 失敗時は LabelAggregate に一切書き込まず、LabelAggregateStatus のみ
 * 失敗状態で upsert する (前回成功時点の LabelAggregate はそのまま残る)。
 * 差分 upsert ではなく全削除して全件挿入にしているのは、
 * ラベル定義が削除・変更されたときに古い行が孤児として残り続けるのを防ぐため。
 * LabelAggregate の行数はラベル定義数と同程度のため、全件書き直しのコストは無視できる。
 * @param prisma - クエリを実行する Prisma クライアント
 */
export async function refreshLabelAggregate(prisma: PrismaClient): Promise<void> {
  const now = new Date()
  let snapshot: LabelAggregateSnapshot
  try {
    snapshot = await computeLabelAggregateSnapshot(prisma)
  } catch (error) {
    await prisma.labelAggregateStatus.upsert({
      where: { id: STATUS_ID },
      create: {
        id: STATUS_ID,
        labeledAccounts: 0,
        lastSuccessAt: null,
        lastAttemptAt: now,
        lastAttemptStatus: 'failed',
        lastErrorMessage: toErrorMessage(error),
      },
      update: {
        lastAttemptAt: now,
        lastAttemptStatus: 'failed',
        lastErrorMessage: toErrorMessage(error),
      },
    })
    return
  }

  await prisma.$transaction([
    prisma.labelAggregate.deleteMany({}),
    prisma.labelAggregate.createMany({
      data: snapshot.distribution.map((entry) => ({
        labelDefinitionId: entry.labelDefinitionId,
        labelKey: entry.labelKey,
        labelDescription: entry.labelDescription,
        trueCount: entry.trueCount,
        totalCount: entry.totalCount,
        updatedAt: now,
      })),
    }),
    prisma.labelAggregateStatus.upsert({
      where: { id: STATUS_ID },
      create: {
        id: STATUS_ID,
        labeledAccounts: snapshot.labeledAccounts,
        lastSuccessAt: now,
        lastAttemptAt: now,
        lastAttemptStatus: 'success',
        lastErrorMessage: null,
      },
      update: {
        labeledAccounts: snapshot.labeledAccounts,
        lastSuccessAt: now,
        lastAttemptAt: now,
        lastAttemptStatus: 'success',
        lastErrorMessage: null,
      },
    }),
  ])
}
