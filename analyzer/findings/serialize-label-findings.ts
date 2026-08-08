import type { Prisma, PrismaClient } from '../generated/prisma'

const MODEL_KEY = 'label_findings'

/**
 * runLabelFindingsSerialized の入力。
 */
export interface RunLabelFindingsSerializedInput {
  /** 今回処理対象の snapshot set が確定した時刻。 */
  snapshotAt: Date
  /** 直列化して実行する Finding 評価本体。 */
  run: (tx: Prisma.TransactionClient) => Promise<void>
}

/**
 * 複数の CrawlRun 起点 build が並行しても Finding 段の lifecycle 遷移が
 * snapshotAt の前後関係と食い違わないよう、ReadModelState (modelKey: 'label_findings')
 * の行ロックで直列化する。より新しい snapshotAt が既に処理済みなら、古い方は
 * lifecycle を巻き戻さないためスキップする。
 * @param prisma - Prisma クライアント
 * @param input - 対象 snapshot set の時刻と実行本体
 */
export async function runLabelFindingsSerialized(
  prisma: PrismaClient,
  input: RunLabelFindingsSerializedInput,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "ReadModelState" ("modelKey", "schemaVersion", "status")
      VALUES (${MODEL_KEY}, 1, 'unknown')
      ON CONFLICT ("modelKey") DO NOTHING
    `
    const rows = await tx.$queryRaw<{ sourceWatermarkAt: Date | null }[]>`
      SELECT "sourceWatermarkAt" FROM "ReadModelState"
      WHERE "modelKey" = ${MODEL_KEY}
      FOR UPDATE
    `
    const state = rows.at(0)
    if (state?.sourceWatermarkAt && input.snapshotAt <= state.sourceWatermarkAt) return

    await input.run(tx)

    await tx.readModelState.update({
      where: { modelKey: MODEL_KEY },
      data: {
        status: 'healthy',
        sourceWatermarkAt: input.snapshotAt,
        lastSuccessAt: new Date(),
      },
    })
  })
}
