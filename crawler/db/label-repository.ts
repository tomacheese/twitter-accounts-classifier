import { randomUUID } from 'node:crypto'
import type { AccountLabel, LabelDefinition, PrismaClient } from '../generated/prisma'
import type { LabelRule, LabelRuleResult } from '../labels/types'

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
 * AccountLabelLatest コメントを参照)。両方の書き込みは同じ `labeledAt` を
 * 共有するため、どちらが「現在の値」かで食い違うことはない。upsert 側は
 * `labeledAt` の比較でガードしており、この関数を並行して呼ぶ複数の呼び出し元
 * 同士が同一アカウントに対して競合しても、新しい評価が古い評価で上書きされる
 * ことはない。history の作成と upsert は CTE で連結した1本の SQL 文にまとめて
 * おり、ネットワークラウンドトリップは1回で済む。
 * @param prisma - Prisma クライアント
 * @param params - 記録するアカウント・ラベル定義・ルール評価結果
 * @returns 作成された `AccountLabel` 履歴行
 */
export async function recordAccountLabel(
  prisma: PrismaClient,
  params: RecordAccountLabelParams,
): Promise<AccountLabel> {
  const id = randomUUID()
  const labeledAt = new Date()
  const [history] = await prisma.$queryRaw<AccountLabel[]>`
    WITH inserted_history AS (
      INSERT INTO "AccountLabel"
        ("id", "accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "labeledAt")
      VALUES
        (${id}, ${params.accountId}, ${params.labelDefinitionId}, ${params.result.value}, ${params.result.confidence}, ${params.result.reason}, ${params.method}, ${params.ruleVersion}, ${labeledAt})
      RETURNING *
    ),
    upserted_latest AS (
      INSERT INTO "AccountLabelLatest" ("accountId", "labelDefinitionId", "value", "labeledAt")
      VALUES (${params.accountId}, ${params.labelDefinitionId}, ${params.result.value}, ${labeledAt})
      ON CONFLICT ("accountId", "labelDefinitionId") DO UPDATE
      SET "value" = EXCLUDED."value", "labeledAt" = EXCLUDED."labeledAt"
      WHERE "AccountLabelLatest"."labeledAt" <= EXCLUDED."labeledAt"
    )
    SELECT * FROM inserted_history
  `
  return history
}
