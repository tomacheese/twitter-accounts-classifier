import type { PrismaClient } from '../generated/prisma'

/**
 * テスト用に、アカウントの true ラベルを 1 件、書き込み関数 `set_label_result` 経由で作る。
 * AccountActiveLabel への直接の書き込みは権限で拒否されるため、テストも同じ経路を使う。
 * 状態行がまだ無い (rev 0) アカウントに最初の書き込みをする前提。
 * @param prisma - Prisma クライアント
 * @param input - 対象アカウント、ラベル、confidence、ルールの版番号
 */
export async function seedTrueLabel(
  prisma: PrismaClient,
  input: {
    accountId: string
    labelDefinitionId: number
    confidence: number
    ruleVersionNo?: number
  },
): Promise<void> {
  const { accountId, labelDefinitionId, confidence, ruleVersionNo = 1 } = input
  await prisma.$queryRaw`
    SELECT set_label_result(
      ARRAY[${accountId}]::bigint[], ARRAY[${labelDefinitionId}]::smallint[], ARRAY[0]::integer[],
      ARRAY[1]::smallint[], ARRAY[${ruleVersionNo}]::smallint[], ARRAY[${confidence}]::double precision[],
      ARRAY['test']::text[], ARRAY['rule']::text[], now(), 1::smallint, NULL::text, NULL::text
    )
  `
}
