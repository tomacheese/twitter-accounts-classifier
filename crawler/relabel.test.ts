import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from './generated/prisma'
import { runRelabelBackfill } from './relabel'
import { LabelRuleRegistry } from './labels/registry'
import type { AccountFeatureBundle, LabelRule } from './labels/types'

const sampleAccount = {
  id: 'acc1',
  screenName: 'someone',
  displayName: 'Someone',
  bio: null,
  followersCount: 10,
  followingCount: 5,
  tweetCount: 3,
  accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
  isBlueVerified: false,
  verifiedType: null,
}

function makeRule(key: string, version: string, value = true): LabelRule {
  return {
    key,
    description: `test rule ${key}`,
    version,
    evaluate: () => ({ value, confidence: 1, reason: 'test' }),
  }
}

function makePrisma(overrides: {
  accounts?: (typeof sampleAccount)[][]
  latestRuleVersions?: { accountId: string; labelDefinitionId: string; ruleVersion: string }[]
  tweetFindManyImpl?: () => Promise<unknown[]>
  queryRawTweetRows?: unknown[]
  queryRawTweetError?: Error
  bulkPersistImpl?: (accountId: string, labelCount: number) => Promise<unknown[]>
  followGraphRows?: unknown[]
}) {
  const accountBatches = overrides.accounts ?? [[sampleAccount], []]
  const findMany = vi.fn().mockImplementation(() => Promise.resolve(accountBatches.shift() ?? []))
  const upsert = vi
    .fn()
    .mockImplementation(({ create }: { create: { key: string } }) =>
      Promise.resolve({ id: `def-${create.key}`, ...create }),
    )
  const tweetFindMany = vi
    .fn()
    .mockImplementation(overrides.tweetFindManyImpl ?? (() => Promise.resolve([])))
  // recordAccountLabelsBulk の呼び出しは1アカウント分の複数ラベルを1本の $queryRaw にまとめる。
  // SQL 文が "UNNEST(" を含むかどうかで他の $queryRaw 呼び出しと区別する。
  // フォローグラフ集約クエリは "Follow" テーブルを FROM 句に含むため、それで区別する
  // (フォロー先方向はサブクエリ内でエイリアスなしの参照になるため "Follow" のみで判定する)。
  // それ以外 (loadLatestRuleVersions) は "DISTINCT ON" を含むかどうかで区別し、
  // 残りはすべて fetchTweetsForAccounts の呼び出しとして扱う。
  // 呼び出し順序ではなく SQL 文の内容で判定するため、新しい集約クエリが追加されても影響を受けない。
  const bulkPersist = vi.fn()
  const queryRaw = vi.fn().mockImplementation((strings: unknown, ...values: unknown[]) => {
    const sql = Array.isArray(strings) ? strings.join('') : ''
    if (sql.includes('UNNEST(')) {
      const ids = values[0] as string[]
      const accountIds = values[1] as string[]
      const labelDefinitionIds = values[2] as string[]
      const resultValues = values[3] as boolean[]
      const accountId = accountIds[0]
      bulkPersist(accountId, ids.length, resultValues)
      return (
        overrides.bulkPersistImpl?.(accountId, ids.length) ??
        Promise.resolve(
          labelDefinitionIds.map((labelDefinitionId) => ({
            id: 'label1',
            accountId,
            labelDefinitionId,
            latestUpserted: true,
          })),
        )
      )
    }
    if (sql.includes('"Follow"')) {
      return Promise.resolve(overrides.followGraphRows ?? [])
    }
    if (sql.includes('DISTINCT ON')) {
      return Promise.resolve(overrides.latestRuleVersions ?? [])
    }
    if (overrides.queryRawTweetError) {
      return Promise.reject(overrides.queryRawTweetError)
    }
    return Promise.resolve(overrides.queryRawTweetRows ?? [])
  })
  const count = vi.fn().mockResolvedValue(0)

  const prisma = {
    account: { findMany, count },
    tweet: { findMany: tweetFindMany },
    labelDefinition: { upsert },
    $queryRaw: queryRaw,
  } as unknown as PrismaClient

  return { prisma, findMany, upsert, bulkPersist, queryRaw, tweetFindMany, count }
}

describe('runRelabelBackfill', () => {
  it('persists a label for a rule the account has never been labeled with', async () => {
    const { prisma, bulkPersist } = makePrisma({ accounts: [[sampleAccount], []] })
    const registry = new LabelRuleRegistry()
    registry.register(makeRule('rule-a', '1.0.0'))

    const result = await runRelabelBackfill(prisma, registry)

    expect(bulkPersist).toHaveBeenCalledTimes(1)
    expect(bulkPersist).toHaveBeenCalledWith('acc1', 1, [true])
    expect(result).toEqual({ accountsProcessed: 1, labelsPersisted: 1 })
  })

  it('skips a rule already at its current version for that account', async () => {
    const { prisma, bulkPersist } = makePrisma({
      accounts: [[sampleAccount], []],
      latestRuleVersions: [
        { accountId: 'acc1', labelDefinitionId: 'def-rule-a', ruleVersion: '1.0.0' },
      ],
    })
    const registry = new LabelRuleRegistry()
    registry.register(makeRule('rule-a', '1.0.0'))

    const result = await runRelabelBackfill(prisma, registry)

    expect(bulkPersist).not.toHaveBeenCalled()
    expect(result).toEqual({ accountsProcessed: 1, labelsPersisted: 0 })
  })

  it('re-persists a rule whose stored version is stale', async () => {
    const { prisma, bulkPersist } = makePrisma({
      accounts: [[sampleAccount], []],
      latestRuleVersions: [
        { accountId: 'acc1', labelDefinitionId: 'def-rule-a', ruleVersion: '1.0.0' },
      ],
    })
    const registry = new LabelRuleRegistry()
    registry.register(makeRule('rule-a', '1.1.0'))

    const result = await runRelabelBackfill(prisma, registry)

    expect(bulkPersist).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ accountsProcessed: 1, labelsPersisted: 1 })
  })

  it('continues to the next account after one account fails to persist its label', async () => {
    const account2 = { ...sampleAccount, id: 'acc2', screenName: 'other' }
    const { prisma, bulkPersist } = makePrisma({
      accounts: [[sampleAccount, account2], []],
      // acc1 の永続化だけを失敗させ、acc2 は成功させる。
      // アカウント単位の try/catch がバッチの残りを止めないことを、
      // 呼び出し順ではなく accountId で判定する(並列処理下では呼び出し順が保証されないため)。
      bulkPersistImpl: (accountId) => {
        if (accountId === 'acc1') return Promise.reject(new Error('db error'))
        return Promise.resolve([
          { id: 'label1', accountId, labelDefinitionId: 'def-rule-a', latestUpserted: true },
        ])
      },
    })
    const registry = new LabelRuleRegistry()
    registry.register(makeRule('rule-a', '1.0.0'))

    const result = await runRelabelBackfill(prisma, registry)

    expect(bulkPersist).toHaveBeenCalledTimes(2)
    // acc1 も失敗はしたが試行済みなので accountsProcessed にはカウントされる。
    expect(result).toEqual({ accountsProcessed: 2, labelsPersisted: 1 })
  })

  it('paginates through multiple batches of accounts', async () => {
    const firstBatch = Array.from({ length: 100 }, (_, i) => ({
      ...sampleAccount,
      id: `acc${i}`,
      screenName: `user${i}`,
    }))
    const secondBatch = [{ ...sampleAccount, id: 'acc100', screenName: 'user100' }]
    const { prisma, findMany, bulkPersist } = makePrisma({
      accounts: [firstBatch, secondBatch, []],
    })
    const registry = new LabelRuleRegistry()
    registry.register(makeRule('rule-a', '1.0.0'))

    const result = await runRelabelBackfill(prisma, registry)

    expect(findMany).toHaveBeenCalledTimes(2)
    expect(bulkPersist).toHaveBeenCalledTimes(101)
    expect(result).toEqual({ accountsProcessed: 101, labelsPersisted: 101 })
  })

  it('skips an account entirely (no tweet query) when every registered rule is already at its current version', async () => {
    const { prisma, tweetFindMany, queryRaw } = makePrisma({
      accounts: [[sampleAccount], []],
      latestRuleVersions: [
        { accountId: 'acc1', labelDefinitionId: 'def-rule-a', ruleVersion: '1.0.0' },
      ],
    })
    const registry = new LabelRuleRegistry()
    registry.register(makeRule('rule-a', '1.0.0'))

    const result = await runRelabelBackfill(prisma, registry)

    // $queryRaw が呼ばれるのは、フォローグラフ集約2本と loadLatestRuleVersions の1本のみ。
    // 唯一のアカウントが既に最新のため、
    // fetchTweetsForAccounts のバッチ取得クエリはそもそも発行されない。
    expect(queryRaw).toHaveBeenCalledTimes(3)
    // tweet.findMany は共有の返信コーパス読み込みでのみ使われ、アカウント単位では使われない。
    expect(tweetFindMany).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ accountsProcessed: 1, labelsPersisted: 0 })
  })

  it('still evaluates every rule for an account where only some rules are stale', async () => {
    const { prisma, bulkPersist } = makePrisma({
      accounts: [[sampleAccount], []],
      latestRuleVersions: [
        { accountId: 'acc1', labelDefinitionId: 'def-rule-a', ruleVersion: '1.0.0' },
        { accountId: 'acc1', labelDefinitionId: 'def-rule-b', ruleVersion: '0.9.0' },
      ],
      queryRawTweetRows: [],
    })
    const registry = new LabelRuleRegistry()
    registry.register(makeRule('rule-a', '1.0.0'))
    registry.register(makeRule('rule-b', '1.0.0'))

    const result = await runRelabelBackfill(prisma, registry)

    expect(bulkPersist).toHaveBeenCalledTimes(1)
    expect(bulkPersist).toHaveBeenCalledWith('acc1', 1, [true])
    expect(result).toEqual({ accountsProcessed: 1, labelsPersisted: 1 })
  })

  it('skips persisting a page whose batched tweet fetch fails, without rejecting the whole backfill', async () => {
    const { prisma, bulkPersist } = makePrisma({
      accounts: [[sampleAccount], []],
      queryRawTweetError: new Error('connection reset'),
    })
    const registry = new LabelRuleRegistry()
    registry.register(makeRule('rule-a', '1.0.0'))

    const result = await runRelabelBackfill(prisma, registry)

    // 取得失敗で空になったツイートサンプルでラベル付けしてしまわないよう永続化せずに残し、
    // stale なまま次回実行で実データを使って再試行できるようにしている。
    // 呼び出し全体を reject させたり、誤って最新済み扱いにしたりはしない。
    // 試行済みとして accountsProcessed にはカウントするため、
    // 進捗ログの分母は totalAccounts に到達できる。
    expect(bulkPersist).not.toHaveBeenCalled()
    expect(result).toEqual({ accountsProcessed: 1, labelsPersisted: 0 })
  })

  it('retries a page left stale by a prior fetch failure once the fetch succeeds', async () => {
    const tweetRow = {
      id: 't1',
      accountId: sampleAccount.id,
      fullText: 'hello',
      createdAt: new Date(),
      retweetCount: 0,
      likeCount: 0,
      isReply: false,
      isRetweet: false,
      isPromoted: false,
      isPaidPromotion: false,
      inReplyToTweetId: null,
    }
    const { prisma, bulkPersist } = makePrisma({
      accounts: [[sampleAccount], []],
      queryRawTweetRows: [tweetRow],
    })
    const registry = new LabelRuleRegistry()
    registry.register(makeRule('rule-a', '1.0.0'))

    const result = await runRelabelBackfill(prisma, registry)

    expect(bulkPersist).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ accountsProcessed: 1, labelsPersisted: 1 })
  })

  it('fetches the top N most recent tweets per account when batching multiple accounts', async () => {
    const account2 = { ...sampleAccount, id: 'acc2', screenName: 'other' }
    const tweetRow = (id: string, accountId: string, fullText: string, createdAt: Date) => ({
      id,
      accountId,
      fullText,
      createdAt,
      retweetCount: 0,
      likeCount: 0,
      isReply: true,
      isRetweet: false,
      isPromoted: false,
      isPaidPromotion: false,
      inReplyToTweetId: null,
    })
    const { prisma } = makePrisma({
      accounts: [[sampleAccount, account2], []],
      queryRawTweetRows: [
        tweetRow('t1', 'acc1', 'x newest', new Date('2026-01-03')),
        tweetRow('t2', 'acc1', 'x older', new Date('2026-01-02')),
        tweetRow('t3', 'acc2', 'y newest', new Date('2026-01-03')),
      ],
    })
    const registry = new LabelRuleRegistry()
    const seenBundles: AccountFeatureBundle[] = []
    registry.register({
      key: 'rule-a',
      description: 'test rule that records the bundle it saw',
      version: '1.0.0',
      evaluate: (bundle) => {
        seenBundles.push(bundle)
        return { value: true, confidence: 1, reason: 'test' }
      },
    })

    await runRelabelBackfill(prisma, registry)

    const bundleAcc1 = seenBundles.find((bundle) => bundle.account.id === 'acc1')
    const bundleAcc2 = seenBundles.find((bundle) => bundle.account.id === 'acc2')
    expect(bundleAcc1?.recentTweets.map((tweet) => tweet.id)).toEqual(['t1', 't2'])
    expect(bundleAcc2?.recentTweets.map((tweet) => tweet.id)).toEqual(['t3'])
  })

  it('wires video provenance and quoted-video metadata from the raw tweet row into the bundle', async () => {
    const tweetRow = {
      id: 't1',
      accountId: sampleAccount.id,
      fullText: 'quoting a video',
      createdAt: new Date(),
      retweetCount: 0,
      likeCount: 0,
      isReply: false,
      isRetweet: false,
      isPromoted: false,
      isPaidPromotion: false,
      foreignVideoSourceCount: 1,
      inReplyToTweetId: null,
      quotedTweetAuthorId: 'bob',
      quotedTweetHasVideo: true,
    }
    const { prisma } = makePrisma({
      accounts: [[sampleAccount], []],
      queryRawTweetRows: [tweetRow],
    })
    const registry = new LabelRuleRegistry()
    const seenBundles: AccountFeatureBundle[] = []
    registry.register({
      key: 'rule-a',
      description: 'test rule that records the bundle it saw',
      version: '1.0.0',
      evaluate: (bundle) => {
        seenBundles.push(bundle)
        return { value: true, confidence: 1, reason: 'test' }
      },
    })

    await runRelabelBackfill(prisma, registry)

    expect(seenBundles[0]?.recentTweets[0]).toMatchObject({
      foreignVideoSourceCount: 1,
      quotedTweetAuthorId: 'bob',
      quotedTweetHasVideo: true,
    })
  })

  it('followGraphLabelSignals がラベルルールの評価に渡る', async () => {
    const rule: LabelRule = {
      key: 'topic_food',
      description: 'test rule topic_food',
      version: '1.0.0',
      evaluate: (bundle: AccountFeatureBundle) => ({
        value: bundle.followGraphLabelSignals?.topic_food !== undefined,
        confidence: 1,
        reason: 'test',
      }),
    }
    const { prisma, bulkPersist } = makePrisma({
      accounts: [[sampleAccount], []],
      followGraphRows: [
        { accountId: 'acc1', labelDefinitionId: 'def-topic_food', labeledCount: 5, totalCount: 15 },
      ],
    })
    const registry = new LabelRuleRegistry()
    registry.register(rule)

    await runRelabelBackfill(prisma, registry)

    // 永続化の有無は ruleVersion の新旧のみで決まり、evaluate の結果値には依存しないため、
    // ラベルの真偽値そのものを検証することで followGraphLabelSignals が実際に bundle に渡っているかどうかを区別できるようにしている。
    expect(bulkPersist).toHaveBeenCalledWith('acc1', 1, [true])
  })

  describe('progress logging', () => {
    afterEach(() => {
      // Date.now と Logger.info をこのブロックのテストごとにスパイし直しており、
      // 復元しないと後続のテスト (この describe 内・および同一ファイル内の後続テスト) に漏れ出す。
      vi.restoreAllMocks()
    })

    it('logs progress once accumulated processed accounts cross the configured interval', async () => {
      const accounts = Array.from({ length: 3 }, (_, i) => ({
        ...sampleAccount,
        id: `acc${i}`,
        screenName: `user${i}`,
      }))
      const { prisma, count } = makePrisma({ accounts: [accounts, []] })
      count.mockResolvedValue(3)
      const registry = new LabelRuleRegistry()
      registry.register(makeRule('rule-a', '1.0.0'))
      const { Logger } = await import('@book000/node-utils')
      const info = vi.spyOn(Logger.configure('relabel'), 'info').mockImplementation(() => undefined)
      let now = 0
      vi.spyOn(Date, 'now').mockImplementation(() => {
        now += 30_000
        return now
      })

      const result = await runRelabelBackfill(prisma, registry, { progressLogIntervalAccounts: 2 })

      expect(result).toEqual({ accountsProcessed: 3, labelsPersisted: 3 })
      const progressLogs = info.mock.calls
        .map(([message]) => message)
        .filter((message) => message.startsWith('Relabel progress:'))
      expect(progressLogs).toHaveLength(1)
      expect(progressLogs[0]).toContain('2/3 accounts processed')
      expect(progressLogs[0]).toContain('2 labels persisted')
    })

    it('does not log progress before the configured interval is reached', async () => {
      const { prisma, count } = makePrisma({ accounts: [[sampleAccount], []] })
      count.mockResolvedValue(1)
      const registry = new LabelRuleRegistry()
      registry.register(makeRule('rule-a', '1.0.0'))
      const { Logger } = await import('@book000/node-utils')
      const info = vi.spyOn(Logger.configure('relabel'), 'info').mockImplementation(() => undefined)

      await runRelabelBackfill(prisma, registry, { progressLogIntervalAccounts: 1000 })

      const progressLogs = info.mock.calls
        .map(([message]) => message)
        .filter((message) => message.startsWith('Relabel progress:'))
      expect(progressLogs).toHaveLength(0)
    })
  })
})
