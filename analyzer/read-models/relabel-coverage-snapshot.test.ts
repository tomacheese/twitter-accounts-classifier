import { beforeEach, describe, expect, it } from 'vitest'
import { createSyntheticId } from 'id-boundary'
import { getPrismaClient } from '../db/client'
import { refreshRelabelCoverageSnapshot } from './relabel-coverage-snapshot'

const prisma = getPrismaClient()

// 乱数の ID は衝突しうるため、基点からの連番で一意にする。
const ID_BASE = BigInt(createSyntheticId())
let idCounter = 0n

async function insertState(versions: number[]): Promise<void> {
  idCounter += 1n
  await prisma.$executeRaw`
    INSERT INTO "AccountLabelState" ("accountId", "evaluatedAt", "versions")
    VALUES (${String(ID_BASE + idCounter)}::bigint, now(), ${versions}::smallint[])
  `
}

describe.skipIf(!process.env.DATABASE_URL)('refreshRelabelCoverageSnapshot', () => {
  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE "AccountLabelState", "RelabelCoverageSnapshot"`
  })

  it('(ラベル, 版) ごとのアカウント数を数え、評価不能は絶対値の版として数え、未評価の添字は数えない', async () => {
    // 添字は LabelDefinition.id (1 始まり)。0 = 未評価、負 = 評価不能。
    await insertState([1, 2, 0])
    await insertState([1, -2])
    await insertState([0, 0, 3])
    await insertState([])

    const written = await refreshRelabelCoverageSnapshot(prisma)

    const rows = await prisma.relabelCoverageSnapshot.findMany({
      orderBy: [{ labelDefinitionId: 'asc' }, { versionNo: 'asc' }],
    })
    expect(rows.map((row) => [row.labelDefinitionId, row.versionNo, row.accountCount])).toEqual([
      [1, 1, 2],
      [2, 2, 2],
      [3, 3, 1],
    ])
    expect(written).toBe(3)
  })

  it('前回のスナップショットを入れ替え、状態が無くなった (ラベル, 版) の行を残さない', async () => {
    await insertState([1])
    await refreshRelabelCoverageSnapshot(prisma)
    await prisma.$executeRaw`TRUNCATE "AccountLabelState"`
    await insertState([0, 5])

    await refreshRelabelCoverageSnapshot(prisma)

    const rows = await prisma.relabelCoverageSnapshot.findMany()
    expect(rows.map((row) => [row.labelDefinitionId, row.versionNo, row.accountCount])).toEqual([
      [2, 5, 1],
    ])
  })
})
