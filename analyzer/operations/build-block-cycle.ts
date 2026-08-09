import type { PrismaClient } from '../generated/prisma'
import {
  deriveWorkItemStage,
  upsertCycleWithStages,
  type CycleStageInput,
  type StageStatus,
} from './cycle-common'

/**
 * @param runStatus - BlockRun.status の値
 * @returns block Stage の状態
 */
export function deriveBlockStageStatus(runStatus: string): StageStatus {
  if (runStatus === 'running') return 'running'
  if (runStatus === 'completed' || runStatus === 'success') return 'succeeded'
  if (runStatus === 'partial') return 'partial'
  if (runStatus === 'failed' || runStatus === 'timeout') return 'failed'
  return 'unknown'
}

/**
 * buildOrUpdateBlockCycle の入力。
 */
export interface BuildOrUpdateBlockCycleInput {
  /** 起点となる BlockRun の ID。 */
  blockRunId: string
}

/**
 * BlockRun 1 件を起点に Cycle と 2 Stage を upsert する。
 * @param prisma - Prisma クライアント
 * @param input - 対象 BlockRun
 */
export async function buildOrUpdateBlockCycle(
  prisma: PrismaClient,
  input: BuildOrUpdateBlockCycleInput,
): Promise<void> {
  const run = await prisma.blockRun.findUniqueOrThrow({ where: { id: input.blockRunId } })

  const reconciliationStage = await deriveWorkItemStage(
    prisma,
    'block_reconciliation',
    'block_run',
    run.id,
  )
  const stages: CycleStageInput[] = [
    {
      stageKey: 'block',
      status: deriveBlockStageStatus(run.status),
      sourceType: 'block_run',
      sourceId: run.id,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? undefined,
    },
    {
      stageKey: 'block_reconciliation',
      sourceType: 'analysis_work_item',
      sourceId: run.id,
      ...reconciliationStage,
    },
  ]

  await upsertCycleWithStages(prisma, {
    kind: 'block',
    sourceType: 'block_run',
    sourceId: run.id,
    triggeredAt: run.startedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? undefined,
    stages,
  })
}
