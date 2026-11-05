import type { PrismaClient } from '../generated/prisma'

// 全アカウントの versions を展開する集計は数十秒かかりうるため、既定の transaction timeout (5 秒) では足りない。
const SNAPSHOT_TRANSACTION_TIMEOUT_MS = 10 * 60 * 1000

/**
 * `AccountLabelState.versions` を展開し、(ラベル, 版) ごとのアカウント数で `RelabelCoverageSnapshot` を作り直す。
 * 評価不能 (負の版) も絶対値の版として数える。現行版で評価済みかどうかが coverage の意味であり、
 * 評価不能かどうかは問わないため。
 * 全行を 1 回の transaction で入れ替えるため、読み手は入れ替え前か後のどちらかの完全な状態だけを見る。
 * @param prisma - Prisma クライアント
 * @returns 書き込んだ (ラベル, 版) の行数
 */
export async function refreshRelabelCoverageSnapshot(prisma: PrismaClient): Promise<number> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`DELETE FROM "RelabelCoverageSnapshot"`
      return tx.$executeRaw`
        INSERT INTO "RelabelCoverageSnapshot" ("computedAt", "accountCount", "labelDefinitionId", "versionNo")
        SELECT clock_timestamp(), count(*)::int, v."labelDefinitionId"::smallint, abs(v."version")::smallint
        FROM "AccountLabelState" AS s
        CROSS JOIN LATERAL unnest(s."versions") WITH ORDINALITY AS v("version", "labelDefinitionId")
        WHERE v."version" <> 0
        GROUP BY v."labelDefinitionId", abs(v."version")
      `
    },
    { timeout: SNAPSHOT_TRANSACTION_TIMEOUT_MS },
  )
}
