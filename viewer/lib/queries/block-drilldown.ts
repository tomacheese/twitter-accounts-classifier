import type { PrismaClient } from '../../generated/prisma'

/** Block 詳細の action 1 件。 */
export interface BlockActionView {
  id: string
  blockedId: string
  labelKey: string
  confidence: number
  result: string
  errorMessage: string | null
  outboxStatus: string | null
}

/** Block 詳細の account 単位テーブル 1 行。 */
export interface BlockAccountRunView {
  id: string
  username: string
  candidatesCount: number
  blockedCount: number
  failedCount: number
  status: string
  errorMessage: string | null
  actions: BlockActionView[]
}

/**
 * 中断・再開により同じ username の BlockAccountRun が複数残ることがあるため、
 * 一番新しい試行のみ残す。
 * @param accountRuns - startedAt 昇順の BlockAccountRun 一覧
 * @returns username ごとに最新の 1 件へ絞った一覧
 */
function latestByUsername<T extends { username: string }>(accountRuns: T[]): T[] {
  const latestByUsernameMap = new Map<string, T>()
  for (const run of accountRuns) {
    latestByUsernameMap.set(run.username, run)
  }
  return [...latestByUsernameMap.values()]
}

/**
 * @param prisma - Prisma クライアント
 * @param blockRunId - 対象 BlockRun の ID
 * @returns account 単位の counts と、label key 解決済み・outbox 状態付きの action 一覧
 */
export async function getBlockAccountRunsWithActions(
  prisma: PrismaClient,
  blockRunId: string,
): Promise<BlockAccountRunView[]> {
  const allAccountRuns = await prisma.blockAccountRun.findMany({
    where: { blockRunId },
    orderBy: [{ startedAt: 'asc' }],
  })
  const accountRuns = latestByUsername(allAccountRuns)
  const accountRunIds = accountRuns.map((run) => run.id)
  const actions = await prisma.blockAction.findMany({
    where: { blockAccountRunId: { in: accountRunIds } },
    orderBy: [{ createdAt: 'asc' }],
  })

  const labelDefinitions = await prisma.labelDefinition.findMany({
    where: { id: { in: actions.map((action) => action.labelDefinitionId) } },
  })
  const labelKeyById = new Map(labelDefinitions.map((label) => [label.id, label.key]))

  const outboxEntryIds = actions
    .map((action) => action.outboxEntryId)
    .filter((id): id is string => id !== null)
  const outboxEntries = await prisma.blockOutboxEntry.findMany({
    where: { id: { in: outboxEntryIds } },
  })
  const outboxStatusById = new Map(outboxEntries.map((entry) => [entry.id, entry.status]))

  const actionsByAccountRunId = new Map<string, BlockActionView[]>()
  for (const action of actions) {
    const list = actionsByAccountRunId.get(action.blockAccountRunId) ?? []
    list.push({
      id: action.id,
      blockedId: action.blockedId,
      labelKey: labelKeyById.get(action.labelDefinitionId) ?? action.labelDefinitionId,
      confidence: action.confidence,
      result: action.result,
      errorMessage: action.errorMessage,
      outboxStatus: action.outboxEntryId
        ? (outboxStatusById.get(action.outboxEntryId) ?? null)
        : null,
    })
    actionsByAccountRunId.set(action.blockAccountRunId, list)
  }

  return accountRuns.map((run) => ({
    id: run.id,
    username: run.username,
    candidatesCount: run.candidatesCount,
    blockedCount: run.blockedCount,
    failedCount: run.failedCount,
    status: run.status,
    errorMessage: run.errorMessage,
    actions: actionsByAccountRunId.get(run.id) ?? [],
  }))
}
