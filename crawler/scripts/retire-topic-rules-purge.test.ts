import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import {
  PURGE_TABLES,
  RETIRED_TOPIC_LABEL_KEYS,
  runRetireTopicRulesPurge,
  type PurgeDependencies,
} from './retire-topic-rules-purge'

function makePrisma(options: {
  labelTables?: string[]
  definitionIds?: string[]
  executeRaw: (sql: string, ...params: unknown[]) => number
}) {
  const executeRawUnsafe = vi.fn((sql: string, ...params: unknown[]) =>
    Promise.resolve(options.executeRaw(sql, ...params)),
  )
  const queryRawUnsafe = vi
    .fn()
    .mockResolvedValue(
      (options.labelTables ?? [...PURGE_TABLES]).map((tableName) => ({ tableName })),
    )
  const findMany = vi
    .fn()
    .mockResolvedValue((options.definitionIds ?? ['l1', 'l2']).map((id) => ({ id })))
  const prisma = {
    $executeRawUnsafe: executeRawUnsafe,
    $queryRawUnsafe: queryRawUnsafe,
    labelDefinition: { findMany },
  } as unknown as PrismaClient
  return { prisma, executeRawUnsafe, findMany }
}

function makeDeps(prisma: PrismaClient): PurgeDependencies & { logs: string[] } {
  const logs: string[] = []
  return {
    prisma,
    options: { batchSize: 3, sleepMs: 7 },
    sleep: vi.fn().mockResolvedValue(undefined),
    log: (message) => logs.push(message),
    logs,
  }
}

describe('runRetireTopicRulesPurge', () => {
  it('looks up exactly the 20 retired topic_* keys', async () => {
    const { prisma, findMany } = makePrisma({ executeRaw: () => 0 })

    await runRetireTopicRulesPurge(makeDeps(prisma))

    expect(RETIRED_TOPIC_LABEL_KEYS).toHaveLength(20)
    expect(RETIRED_TOPIC_LABEL_KEYS.every((key) => key.startsWith('topic_'))).toBe(true)
    expect(findMany).toHaveBeenCalledWith({
      where: { key: { in: [...RETIRED_TOPIC_LABEL_KEYS] } },
      select: { id: true },
    })
  })

  it('deletes each table in batches until a batch affects no rows, then moves to the next table', async () => {
    const remaining = new Map<string, number>([
      ['AccountLabelLatest', 7],
      ['AccountClassificationLatest', 2],
    ])
    const { prisma, executeRawUnsafe } = makePrisma({
      executeRaw: (sql, ...params) => {
        const table = /^DELETE FROM "(\w+)" WHERE ctid/.exec(sql)?.[1]
        if (!table || !remaining.has(table)) return 0
        const batch = Math.min(params[1] as number, remaining.get(table) ?? 0)
        remaining.set(table, (remaining.get(table) ?? 0) - batch)
        return batch
      },
    })
    const deps = makeDeps(prisma)

    await runRetireTopicRulesPurge(deps)

    expect(deps.logs).toContain('Purged 7 rows from AccountLabelLatest')
    expect(deps.logs).toContain('Purged 2 rows from AccountClassificationLatest')
    const labelBatches = executeRawUnsafe.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.startsWith('DELETE FROM "AccountLabelLatest"'),
    )
    expect(labelBatches).toHaveLength(4)
    expect(labelBatches[0].slice(1)).toEqual([['l1', 'l2'], 3])
    expect(deps.sleep).toHaveBeenCalledWith(7)
  })

  it('purges tables in the declared order, with the aggregate tables after the row tables', async () => {
    const { prisma, executeRawUnsafe } = makePrisma({ executeRaw: () => 0 })

    await runRetireTopicRulesPurge(makeDeps(prisma))

    const order = executeRawUnsafe.mock.calls
      .map(([sql]) => /^DELETE FROM "(\w+)" WHERE ctid/.exec(sql)?.[1])
      .filter((table): table is string => table !== undefined)
    expect(order).toEqual([...PURGE_TABLES])
    expect(PURGE_TABLES.indexOf('AccountClassificationLatest')).toBeLessThan(
      PURGE_TABLES.indexOf('AccountClassificationFreshnessBucket'),
    )
  })

  it('cleans activeLabelKeys with the retired keys and deletes the definitions last', async () => {
    const { prisma, executeRawUnsafe } = makePrisma({ executeRaw: () => 0 })

    await runRetireTopicRulesPurge(makeDeps(prisma))

    const sqls = executeRawUnsafe.mock.calls.map(([sql]) => sql)
    const updateIndex = sqls.findIndex((sql) => sql.startsWith('UPDATE "AccountSummaryLatest"'))
    const definitionIndex = sqls.findIndex((sql) => sql.startsWith('DELETE FROM "LabelDefinition"'))
    expect(updateIndex).toBeGreaterThan(sqls.length - 3)
    expect(definitionIndex).toBe(sqls.length - 1)
    expect(executeRawUnsafe.mock.calls[updateIndex].slice(1)).toEqual([
      [...RETIRED_TOPIC_LABEL_KEYS],
      3,
    ])
    expect(executeRawUnsafe.mock.calls[definitionIndex].slice(1)).toEqual([['l1', 'l2']])
  })

  it('refuses to run when a table with labelDefinitionId is not covered, before deleting anything', async () => {
    const { prisma, executeRawUnsafe } = makePrisma({
      labelTables: [...PURGE_TABLES, 'FutureLabelTable'],
      executeRaw: () => 0,
    })

    await expect(runRetireTopicRulesPurge(makeDeps(prisma))).rejects.toThrow(
      'Tables with labelDefinitionId are not covered by the purge: FutureLabelTable',
    )
    expect(executeRawUnsafe).not.toHaveBeenCalled()
  })

  it('purges the optional legacy table only when it exists', async () => {
    const withLegacy = makePrisma({
      labelTables: [...PURGE_TABLES, 'AccountLabel_pre_compaction'],
      executeRaw: () => 0,
    })
    await runRetireTopicRulesPurge(makeDeps(withLegacy.prisma))
    const withoutLegacy = makePrisma({ executeRaw: () => 0 })
    await runRetireTopicRulesPurge(makeDeps(withoutLegacy.prisma))

    const purgedTables = (executeRawUnsafe: typeof withLegacy.executeRawUnsafe) =>
      executeRawUnsafe.mock.calls
        .map(([sql]) => /^DELETE FROM "(\w+)" WHERE ctid/.exec(sql)?.[1])
        .filter((table): table is string => table !== undefined)
    expect(purgedTables(withLegacy.executeRawUnsafe)).toEqual([
      ...PURGE_TABLES,
      'AccountLabel_pre_compaction',
    ])
    expect(purgedTables(withoutLegacy.executeRawUnsafe)).toEqual([...PURGE_TABLES])
  })

  it('is a no-op when the definitions are already gone', async () => {
    const { prisma, executeRawUnsafe } = makePrisma({ definitionIds: [], executeRaw: () => 0 })
    const deps = makeDeps(prisma)

    await runRetireTopicRulesPurge(deps)

    expect(deps.logs).toContain('Deleted 0 rows from LabelDefinition')
    const firstDelete = executeRawUnsafe.mock.calls[0]
    expect(firstDelete.slice(1)).toEqual([[], 3])
  })
})
