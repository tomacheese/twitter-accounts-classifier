import { randomUUID } from 'node:crypto'
import { Logger } from '@book000/node-utils'
import type { AccountLabel, LabelDefinition, PrismaClient } from '../generated/prisma'
import type { LabelRule, LabelRuleResult } from '../labels/types'

const logger = Logger.configure('label-repository')

export interface LabelDefinitionInput {
  key: string
  description: string
}

export async function ensureLabelDefinition(
  prisma: PrismaClient,
  input: LabelDefinitionInput,
): Promise<LabelDefinition> {
  return prisma.labelDefinition.upsert({
    where: { key: input.key },
    create: input,
    update: { description: input.description },
  })
}

/**
 * Ensures a `LabelDefinition` exists for every given rule.
 * @param prisma - the Prisma client
 * @param rules - the rules to ensure `LabelDefinition`s for
 * @returns a map from each rule's key to its `LabelDefinition` id
 */
export async function ensureLabelDefinitionsForRules(
  prisma: PrismaClient,
  rules: LabelRule[],
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    rules.map(async (rule) => {
      const definition = await ensureLabelDefinition(prisma, {
        key: rule.key,
        description: rule.description,
      })
      return [rule.key, definition.id] as const
    }),
  )
  return new Map(entries)
}

export interface RecordAccountLabelParams {
  accountId: string
  labelDefinitionId: string
  result: LabelRuleResult
  method: string
  ruleVersion: string
}

/**
 * ルール評価結果を記録する: `AccountLabel` の履歴に追記すると同時に、
 * dashboard/アカウント一覧の各クエリが読む `AccountLabelLatest` の該当行も
 * upsert する (テーブルの設計意図は prisma/schema.prisma の
 * AccountLabelLatest コメントを参照)。両方の書き込みは SQL 側の `now()` を
 * 共有するため、どちらが「現在の値」かで食い違うことはない (Node/app 側の
 * クロックで生成すると、複数の app サーバー間でクロックがずれた場合に
 * upsert 側のガードが本来より新しい評価を無音に取りこぼしうる)。upsert 側は
 * `labeledAt` の比較でガードしており、この関数を並行して呼ぶ複数の呼び出し元
 * 同士が同一アカウントに対して競合しても、新しい評価が古い評価で上書きされる
 * ことはない。history の作成と upsert は CTE で連結した1本の SQL 文にまとめて
 * おり、ネットワークラウンドトリップは1回で済む。`id` は raw INSERT が
 * Prisma クライアント側の `@default(cuid())` を経由しないため `randomUUID()`
 * で生成しており、時系列でソート可能ではない。同一アカウント・同一ラベルに
 * 対して寸分違わず同じ `labeledAt` で複数回呼ばれる (バックフィルと通常の
 * クロールが競合するなど) 極めて稀なケースでのみ関わる id の大小関係は
 * 意味を持たないが、そのようなタイの発生自体が稀なため許容する。
 * @param prisma - Prisma クライアント
 * @param params - 記録するアカウント・ラベル定義・ルール評価結果
 * @returns 作成された `AccountLabel` 履歴行
 */
interface RecordAccountLabelRow extends AccountLabel {
  latestUpserted: boolean
}

export async function recordAccountLabel(
  prisma: PrismaClient,
  params: RecordAccountLabelParams,
): Promise<AccountLabel> {
  const id = randomUUID()
  const rows = await prisma.$queryRaw<RecordAccountLabelRow[]>`
    WITH shared_now AS (
      SELECT now() AS "labeledAt"
    ),
    inserted_history AS (
      INSERT INTO "AccountLabel"
        ("id", "accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "labeledAt")
      SELECT ${id}, ${params.accountId}, ${params.labelDefinitionId}, ${params.result.value}, ${params.result.confidence}, ${params.result.reason}, ${params.method}, ${params.ruleVersion}, "labeledAt"
      FROM shared_now
      RETURNING *
    ),
    upserted_latest AS (
      INSERT INTO "AccountLabelLatest" ("accountId", "labelDefinitionId", "value", "labeledAt")
      SELECT ${params.accountId}, ${params.labelDefinitionId}, ${params.result.value}, "labeledAt"
      FROM shared_now
      ON CONFLICT ("accountId", "labelDefinitionId") DO UPDATE
      SET "value" = EXCLUDED."value", "labeledAt" = EXCLUDED."labeledAt"
      WHERE "AccountLabelLatest"."labeledAt" <= EXCLUDED."labeledAt"
      RETURNING "accountId"
    )
    SELECT ih.*, EXISTS (SELECT 1 FROM upserted_latest) AS "latestUpserted"
    FROM inserted_history ih
  `
  const row = rows.at(0)
  if (!row) {
    throw new Error('recordAccountLabel: INSERT ... RETURNING returned no row')
  }
  const { latestUpserted, ...history } = row
  if (!latestUpserted) {
    // ON CONFLICT ... WHERE ガードが false になった、つまり AccountLabelLatest
    // 側に既にこれ以降の labeledAt を持つ行がある状態。history への追記自体は
    // 成功しているため例外にはしないが、後続の集計から見落とされないよう記録に残す。
    logger.warn(
      `recordAccountLabel: AccountLabelLatest upsert guard skipped the write (accountId=${params.accountId}, labelDefinitionId=${params.labelDefinitionId})`,
    )
  }
  return history
}
