import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { PrismaClient } from './generated/prisma'
import { LabelRuleRegistry } from './labels/registry'
import type { LabelRule } from './labels/types'
import * as workItemRepository from './db/analysis-work-item-repository'
import * as labelRepository from './db/label-repository'
import * as tweetRepository from './db/tweet-repository'
import * as followGraphIndexModule from './labels/follow-graph-label-index'
import * as replyCorpusModule from './db/reply-corpus'
import {
  evaluateAccountRelabelItems,
  runRelabelWorkerCycleOnce,
  scanForStaleAccounts,
} from './relabel-worker'

describe('evaluateAccountRelabelItems', () => {
  it('claim 済みの work item を評価・complete まで処理する', async () => {
    const rule: LabelRule = {
      key: 'test_rule',
      description: 'test',
      version: '1.0.0',
      evaluate: () => ({ value: true, confidence: 1, reason: 'test' }),
    }
    const registry = new LabelRuleRegistry()
    registry.register(rule)

    const completeSpy = vi
      .spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk')
      .mockResolvedValue([{ id: 'wi-1', status: 'succeeded' }])
    const recordLabelsSpy = vi
      .spyOn(labelRepository, 'recordAccountLabelsBulkForAccounts')
      .mockResolvedValue([])
    vi.spyOn(tweetRepository, 'loadRecentTweetsForAccounts').mockResolvedValue(new Map())

    const prisma = {
      account: { findMany: vi.fn().mockResolvedValue([{ id: 'alice' }]) },
    } as unknown as PrismaClient

    const result = await evaluateAccountRelabelItems(
      prisma,
      [{ id: 'wi-1', triggerId: 'alice' } as never],
      {
        registry,
        labelDefinitionIds: new Map([['test_rule', 'def-1']]),
        duplicateReplyIndex: { countOtherAccounts: () => 0 },
        replyHijackIndex: { swarmSizeFor: () => 0, isEligibleForScreening: () => true },
        followGraphLabelIndex: { signalsFor: () => ({}) },
        concurrency: 1,
        leaseOwner: 'test-worker',
      },
    )

    expect(result.succeeded).toBe(1)
    expect(recordLabelsSpy).toHaveBeenCalledWith(prisma, {
      sourceKind: 'relabel',
      labels: [
        {
          accountId: 'alice',
          labelDefinitionId: 'def-1',
          method: 'test_rule',
          ruleVersion: '1.0.0',
          result: { value: true, confidence: 1, reason: 'test' },
        },
      ],
    })
    expect(completeSpy).toHaveBeenCalledWith(prisma, {
      workItemIds: ['wi-1'],
      leaseOwner: 'test-worker',
    })
  })

  it('account が既に削除されている場合は評価をスキップして succeeded 扱いにする', async () => {
    const completeSpy = vi
      .spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk')
      .mockResolvedValue([{ id: 'wi-1', status: 'succeeded' }])
    vi.spyOn(tweetRepository, 'loadRecentTweetsForAccounts').mockResolvedValue(new Map())

    const prisma = {
      account: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient

    const result = await evaluateAccountRelabelItems(
      prisma,
      [{ id: 'wi-1', triggerId: 'deleted-account' } as never],
      {
        registry: new LabelRuleRegistry(),
        labelDefinitionIds: new Map(),
        duplicateReplyIndex: { countOtherAccounts: () => 0 },
        replyHijackIndex: { swarmSizeFor: () => 0, isEligibleForScreening: () => true },
        followGraphLabelIndex: { signalsFor: () => ({}) },
        concurrency: 1,
        leaseOwner: 'test-worker',
      },
    )

    expect(result.succeeded).toBe(1)
    expect(completeSpy).toHaveBeenCalledWith(prisma, {
      workItemIds: ['wi-1'],
      leaseOwner: 'test-worker',
    })
  })

  it('concurrency を 2 以上に設定すると複数グループへ分割して並走する', async () => {
    vi.spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk').mockImplementation(
      (_prisma, { workItemIds }) =>
        Promise.resolve(workItemIds.map((id) => ({ id, status: 'succeeded' as const }))),
    )
    vi.spyOn(labelRepository, 'recordAccountLabelsBulkForAccounts').mockResolvedValue([])
    vi.spyOn(tweetRepository, 'loadRecentTweetsForAccounts').mockResolvedValue(new Map())
    const pendingResolvers: (() => void)[] = []
    const prisma = {
      account: {
        findMany: vi.fn().mockImplementation(({ where }: { where: { id: { in: string[] } } }) => {
          return new Promise((resolve) => {
            pendingResolvers.push(() => {
              resolve(where.id.in.map((id) => ({ id })))
            })
          })
        }),
      },
    } as unknown as PrismaClient

    const items = [
      { id: 'wi-1', triggerId: 'alice' },
      { id: 'wi-2', triggerId: 'bob' },
      { id: 'wi-3', triggerId: 'carol' },
      { id: 'wi-4', triggerId: 'dave' },
    ] as never[]

    const resultPromise = evaluateAccountRelabelItems(prisma, items, {
      registry: new LabelRuleRegistry(),
      labelDefinitionIds: new Map(),
      duplicateReplyIndex: { countOtherAccounts: () => 0 },
      replyHijackIndex: { swarmSizeFor: () => 0, isEligibleForScreening: () => true },
      followGraphLabelIndex: { signalsFor: () => ({}) },
      concurrency: 2,
      leaseOwner: 'test-worker',
    })

    // concurrency: 2 なら group (alice→carol) と group (bob→dave) が同時に走り出すため、
    // 両グループ先頭の account.findMany が解決前に 2 件同時に保留する。concurrency: 1 の直列実行では
    // この時点で保留は 1 件にしかならないため、この件数がグループ並走の検証点になる。
    expect(pendingResolvers).toHaveLength(2)

    while (pendingResolvers.length > 0) {
      const toResolve = pendingResolvers.splice(0)
      for (const resolve of toResolve) resolve()
      for (let i = 0; i < 10; i++) {
        await Promise.resolve()
      }
    }

    const result = await resultPromise
    expect(result.succeeded).toBe(4)
  })
})

describe('scanForStaleAccounts', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('カーソル位置から bounded 件数だけ scan し、stale な account を requestAccountRelabelBulk する', async () => {
    const requestSpy = vi.spyOn(workItemRepository, 'requestAccountRelabelBulk').mockResolvedValue()
    const prisma = {
      relabelScanCursor: {
        findUnique: vi.fn().mockResolvedValue({ id: 'singleton', lastScannedAccountId: null }),
        upsert: vi.fn().mockResolvedValue({}),
      },
      account: {
        findMany: vi.fn().mockResolvedValue([{ id: 'acct-1' }, { id: 'acct-2' }]),
      },
      accountLabelLatest: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { accountId: 'acct-1', labelDefinitionId: 'def-1', ruleVersion: '1.0.0' },
          ]),
      },
    } as unknown as PrismaClient

    const rule: LabelRule = {
      key: 'test_rule',
      description: 'test',
      version: '2.0.0',
      evaluate: () => ({ value: true, confidence: 1, reason: 'test' }),
    }
    const registry = new LabelRuleRegistry()
    registry.register(rule)

    const result = await scanForStaleAccounts(prisma, {
      registry,
      labelDefinitionIds: new Map([['test_rule', 'def-1']]),
      batchSize: 500,
    })

    expect(result.scanned).toBe(2)
    // acct-1 は ruleVersion が古い (1.0.0 != 2.0.0)、acct-2 は行自体がない → どちらも stale
    expect(requestSpy).toHaveBeenCalledWith(prisma, ['acct-1', 'acct-2'])
    expect(result.requested).toBe(2)
    expect(result.wrapped).toBe(false)
  })

  it('accountIds が chunk size を超える場合、AccountLabelLatest lookup を chunk ごとに分割し labelDefinitionId でも絞り込む', async () => {
    vi.stubEnv('RELABELER_LABEL_LOOKUP_CHUNK_SIZE', '2')
    vi.spyOn(workItemRepository, 'requestAccountRelabelBulk').mockResolvedValue()
    const findManyCalls: unknown[] = []
    const prisma = {
      relabelScanCursor: {
        findUnique: vi.fn().mockResolvedValue({ id: 'singleton', lastScannedAccountId: null }),
        upsert: vi.fn().mockResolvedValue({}),
      },
      account: {
        findMany: vi.fn().mockResolvedValue([{ id: 'acct-1' }, { id: 'acct-2' }, { id: 'acct-3' }]),
      },
      accountLabelLatest: {
        findMany: vi.fn().mockImplementation((args: unknown) => {
          findManyCalls.push(args)
          return Promise.resolve([])
        }),
      },
    } as unknown as PrismaClient

    const rule: LabelRule = {
      key: 'test_rule',
      description: 'test',
      version: '1.0.0',
      evaluate: () => ({ value: true, confidence: 1, reason: 'test' }),
    }
    const registry = new LabelRuleRegistry()
    registry.register(rule)

    await scanForStaleAccounts(prisma, {
      registry,
      labelDefinitionIds: new Map([['test_rule', 'def-1']]),
      batchSize: 500,
    })

    // chunk size 2 に対し 3 件の account なので chunk は [acct-1, acct-2] と [acct-3] の2つに分かれる。
    expect(findManyCalls).toHaveLength(2)
    for (const call of findManyCalls) {
      const where = (call as { where: { labelDefinitionId: { in: string[] } } }).where
      expect(where.labelDefinitionId).toEqual({ in: ['def-1'] })
    }
  })
})

function makeCursorPrisma(overrides: Record<string, unknown> = {}): PrismaClient {
  return {
    relabelScanCursor: {
      findUnique: vi.fn().mockResolvedValue({ id: 'singleton', lastScannedAccountId: null }),
      upsert: vi.fn().mockResolvedValue({}),
    },
    account: { findMany: vi.fn().mockResolvedValue([]) },
    accountLabelLatest: { findMany: vi.fn().mockResolvedValue([]) },
    analysisWorkItem: { update: vi.fn().mockResolvedValue({}) },
    ...overrides,
  } as unknown as PrismaClient
}

describe('runRelabelWorkerCycleOnce', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(tweetRepository, 'loadRecentTweetsForAccounts').mockResolvedValue(new Map())
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('drain backlog が worker 上限に達している間は stale scan と cursor 更新を行わない', async () => {
    vi.stubEnv('RELABELER_WORKER_BATCH_SIZE', '2')
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(new Map())
    const peekSpy = vi.spyOn(workItemRepository, 'peekWorkItemCandidates').mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' },
      { id: 'wi-2', triggerId: 'bob' },
    ])
    vi.spyOn(replyCorpusModule, 'loadReplyCorpus').mockResolvedValue([])
    vi.spyOn(followGraphIndexModule, 'buildFollowGraphLabelIndex').mockResolvedValue({
      signalsFor: () => ({}),
    })
    vi.spyOn(workItemRepository, 'claimWorkItemBatchByIds').mockResolvedValue([])
    const accountFindMany = vi.fn().mockResolvedValue([])
    const cursorUpsert = vi.fn().mockResolvedValue({})
    const prisma = makeCursorPrisma({
      account: { findMany: accountFindMany },
      relabelScanCursor: { findUnique: vi.fn().mockResolvedValue(null), upsert: cursorUpsert },
    })

    await runRelabelWorkerCycleOnce(prisma)

    expect(peekSpy).toHaveBeenCalledTimes(1)
    expect(accountFindMany).not.toHaveBeenCalled()
    expect(cursorUpsert).not.toHaveBeenCalled()
  })

  it('drain backlog が worker 上限未満の場合だけ stale scan 後に候補を取り直す', async () => {
    vi.stubEnv('RELABELER_WORKER_BATCH_SIZE', '2')
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(new Map())
    const peekSpy = vi
      .spyOn(workItemRepository, 'peekWorkItemCandidates')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'wi-1', triggerId: 'alice' }])
    vi.spyOn(replyCorpusModule, 'loadReplyCorpus').mockResolvedValue([])
    vi.spyOn(followGraphIndexModule, 'buildFollowGraphLabelIndex').mockResolvedValue({
      signalsFor: () => ({}),
    })
    vi.spyOn(workItemRepository, 'claimWorkItemBatchByIds').mockResolvedValue([])
    const accountFindMany = vi.fn().mockResolvedValue([])
    const cursorUpsert = vi.fn().mockResolvedValue({})
    const prisma = makeCursorPrisma({
      account: { findMany: accountFindMany },
      relabelScanCursor: { findUnique: vi.fn().mockResolvedValue(null), upsert: cursorUpsert },
    })

    await runRelabelWorkerCycleOnce(prisma)

    expect(peekSpy).toHaveBeenCalledTimes(2)
    expect(accountFindMany).toHaveBeenCalled()
    expect(cursorUpsert).not.toHaveBeenCalled()
  })

  it('peek 候補が 0 件の場合、buildFollowGraphLabelIndex・loadReplyCorpus・claim を一切行わない', async () => {
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(new Map())
    const peekSpy = vi.spyOn(workItemRepository, 'peekWorkItemCandidates').mockResolvedValue([])
    const claimSpy = vi.spyOn(workItemRepository, 'claimWorkItemBatchByIds')
    const followGraphSpy = vi.spyOn(followGraphIndexModule, 'buildFollowGraphLabelIndex')
    const replyCorpusSpy = vi.spyOn(replyCorpusModule, 'loadReplyCorpus')
    const prisma = makeCursorPrisma()

    await runRelabelWorkerCycleOnce(prisma)

    expect(peekSpy).toHaveBeenCalled()
    expect(claimSpy).not.toHaveBeenCalled()
    expect(followGraphSpy).not.toHaveBeenCalled()
    expect(replyCorpusSpy).not.toHaveBeenCalled()
  })

  it('buildFollowGraphLabelIndex には peek した全 accountId を1回だけ渡し、usesFollowGraphSignal を持つルールのラベルだけを渡す', async () => {
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(
      new Map([
        ['topic_anime', 'ld-follow'],
        ['ad_pr_hashtag', 'ld-no-follow'],
      ]),
    )
    vi.spyOn(workItemRepository, 'peekWorkItemCandidates').mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' },
      { id: 'wi-2', triggerId: 'bob' },
    ])
    vi.spyOn(workItemRepository, 'claimWorkItemBatchByIds').mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' } as never,
      { id: 'wi-2', triggerId: 'bob' } as never,
    ])
    vi.spyOn(replyCorpusModule, 'loadReplyCorpus').mockResolvedValue([])
    vi.spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk').mockResolvedValue([])
    const followGraphSpy = vi
      .spyOn(followGraphIndexModule, 'buildFollowGraphLabelIndex')
      .mockResolvedValue({ signalsFor: () => ({}) })
    const prisma = makeCursorPrisma({
      account: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    })

    await runRelabelWorkerCycleOnce(prisma)

    expect(followGraphSpy).toHaveBeenCalledTimes(1)
    expect(followGraphSpy).toHaveBeenCalledWith(prisma, new Map([['topic_anime', 'ld-follow']]), {
      accountIds: ['alice', 'bob'],
      chunkSize: 1000,
    })
  })

  it('index 構築が候補確定後・claim 前に失敗した場合、1 件も claim されず lastErrorSummary も書かれない', async () => {
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(new Map())
    vi.spyOn(workItemRepository, 'peekWorkItemCandidates').mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' },
    ])
    const claimSpy = vi.spyOn(workItemRepository, 'claimWorkItemBatchByIds')
    vi.spyOn(replyCorpusModule, 'loadReplyCorpus').mockRejectedValue(new Error('db timeout'))
    const updateSpy = vi.fn().mockResolvedValue({})
    const prisma = makeCursorPrisma({ analysisWorkItem: { update: updateSpy } })

    await expect(runRelabelWorkerCycleOnce(prisma)).rejects.toThrow('db timeout')

    expect(claimSpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('peek した WorkItem id 集合だけを RELABELER_WORKER_CHUNK_SIZE ごとの chunk で claim し、候補外を補充しない', async () => {
    vi.stubEnv('RELABELER_WORKER_CHUNK_SIZE', '2')
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(new Map())
    vi.spyOn(workItemRepository, 'peekWorkItemCandidates').mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' },
      { id: 'wi-2', triggerId: 'bob' },
      { id: 'wi-3', triggerId: 'carol' },
    ])
    vi.spyOn(replyCorpusModule, 'loadReplyCorpus').mockResolvedValue([])
    vi.spyOn(followGraphIndexModule, 'buildFollowGraphLabelIndex').mockResolvedValue({
      signalsFor: () => ({}),
    })
    vi.spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk').mockImplementation(
      (_prisma, { workItemIds }) =>
        Promise.resolve(workItemIds.map((id) => ({ id, status: 'succeeded' as const }))),
    )
    const claimSpy = vi
      .spyOn(workItemRepository, 'claimWorkItemBatchByIds')
      .mockImplementation((_prisma, { ids }) =>
        Promise.resolve(ids.map((id) => ({ id, triggerId: `t-${id}` }) as never)),
      )
    const prisma = makeCursorPrisma({
      account: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    })

    await runRelabelWorkerCycleOnce(prisma)

    expect(claimSpy).toHaveBeenCalledTimes(2)
    expect(claimSpy).toHaveBeenNthCalledWith(
      1,
      prisma,
      expect.objectContaining({ ids: ['wi-1', 'wi-2'] }),
    )
    expect(claimSpy).toHaveBeenNthCalledWith(2, prisma, expect.objectContaining({ ids: ['wi-3'] }))
  })

  it('競合で一部の候補が claim できなかった場合、その分を他の WorkItem で補充しない', async () => {
    vi.stubEnv('RELABELER_WORKER_CHUNK_SIZE', '2')
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(new Map())
    vi.spyOn(workItemRepository, 'peekWorkItemCandidates').mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' },
      { id: 'wi-2', triggerId: 'bob' },
    ])
    vi.spyOn(replyCorpusModule, 'loadReplyCorpus').mockResolvedValue([])
    vi.spyOn(followGraphIndexModule, 'buildFollowGraphLabelIndex').mockResolvedValue({
      signalsFor: () => ({}),
    })
    const completeSpy = vi
      .spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk')
      .mockResolvedValue([{ id: 'wi-1', status: 'succeeded' }])
    // wi-2 は別ワーカーとの競合で SKIP LOCKED により claim できなかったことを模す。
    vi.spyOn(workItemRepository, 'claimWorkItemBatchByIds').mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' } as never,
    ])
    const prisma = makeCursorPrisma({
      account: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    })

    await runRelabelWorkerCycleOnce(prisma)

    expect(completeSpy).toHaveBeenCalledTimes(1)
    expect(completeSpy).toHaveBeenCalledWith(prisma, {
      workItemIds: ['wi-1'],
      leaseOwner: expect.any(String),
    })
  })

  it('自己フィードバック防止: chunk A の評価後も chunk B の評価には同じ followGraphLabelIndex インスタンスを使う', async () => {
    vi.stubEnv('RELABELER_WORKER_CHUNK_SIZE', '1')
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(new Map())
    vi.spyOn(workItemRepository, 'peekWorkItemCandidates').mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' },
      { id: 'wi-2', triggerId: 'bob' },
    ])
    vi.spyOn(replyCorpusModule, 'loadReplyCorpus').mockResolvedValue([])
    const sharedIndex = { signalsFor: () => ({}) }
    const followGraphSpy = vi
      .spyOn(followGraphIndexModule, 'buildFollowGraphLabelIndex')
      .mockResolvedValue(sharedIndex)
    vi.spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk').mockImplementation(
      (_prisma, { workItemIds }) =>
        Promise.resolve(workItemIds.map((id) => ({ id, status: 'succeeded' as const }))),
    )
    vi.spyOn(workItemRepository, 'claimWorkItemBatchByIds').mockImplementation((_prisma, { ids }) =>
      Promise.resolve(
        ids.map((id) => ({ id, triggerId: id === 'wi-1' ? 'alice' : 'bob' }) as never),
      ),
    )
    const accountFindMany = vi.fn().mockResolvedValue([])
    const prisma = makeCursorPrisma({
      account: { findMany: accountFindMany },
    })

    await runRelabelWorkerCycleOnce(prisma)

    // followGraphLabelIndex は cycle 全体で1回しか構築されず、2 chunk とも同じインスタンスを参照する。
    expect(followGraphSpy).toHaveBeenCalledTimes(1)
  })

  it('2 chunk 目の claim が失敗した場合、1 chunk 目は complete 済みのまま例外を再送出する (blast radius は chunk size 以下)', async () => {
    vi.stubEnv('RELABELER_WORKER_CHUNK_SIZE', '1')
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(new Map())
    vi.spyOn(workItemRepository, 'peekWorkItemCandidates').mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' },
      { id: 'wi-2', triggerId: 'bob' },
    ])
    vi.spyOn(replyCorpusModule, 'loadReplyCorpus').mockResolvedValue([])
    vi.spyOn(followGraphIndexModule, 'buildFollowGraphLabelIndex').mockResolvedValue({
      signalsFor: () => ({}),
    })
    const completeSpy = vi
      .spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk')
      .mockResolvedValue([{ id: 'wi-1', status: 'succeeded' }])
    vi.spyOn(workItemRepository, 'claimWorkItemBatchByIds')
      .mockResolvedValueOnce([{ id: 'wi-1', triggerId: 'alice' } as never])
      .mockRejectedValueOnce(new Error('claim crashed'))
    const prisma = makeCursorPrisma({
      account: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    })

    await expect(runRelabelWorkerCycleOnce(prisma)).rejects.toThrow('claim crashed')

    // wi-2 は claim 自体が失敗しており lease されていないため、書き残す lastErrorSummary は無い。
    // 1 chunk 目 (wi-1) は既に complete 済みで、2 chunk 目の失敗による影響を受けない。
    expect(completeSpy).toHaveBeenCalledTimes(1)
    expect(completeSpy).toHaveBeenCalledWith(prisma, {
      workItemIds: ['wi-1'],
      leaseOwner: expect.any(String),
    })
  })
})
