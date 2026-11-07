import { describe, expect, it } from 'vitest'
import { getPrismaClient } from './db/client'
import {
  recordRecentTweetsFetchSuccess,
  upsertAccount,
  type AccountProfileInput,
} from './db/account-repository'
import {
  findMissingTweetIds,
  findTweetContextsByIds,
  loadRecentTweetsForAccounts,
  upsertTweets,
  type TweetInput,
} from './db/tweet-repository'
import { recordCrawlAccountLabelsAtomic } from './db/label-repository'
import { verifiedBlueIndividualRule } from './labels/rules/verified-blue-individual'
import { runRelabelWorkerCycleOnce } from './relabel-worker'

// scripts/db/e2e-smoke.sh が crawler、analyzer、viewer の順に同じ scratch DB へ流す smoke の 1 段目。
// 通常のテスト実行ではデータを残さないよう、E2E_SMOKE=1 のときだけ動く。
// 空の DB と、最小権限の crawler ロール (所有者ではない) で接続する前提とする。
const enabled = process.env.DATABASE_URL !== undefined && process.env.E2E_SMOKE === '1'

const ALICE = '1900000000000000001'
const BOB = '1900000000000000002'
const CAROL = '1900000000000000003'

function makeAccount(id: string, overrides: Partial<AccountProfileInput>): AccountProfileInput {
  return {
    id,
    screenName: `smoke_${id.slice(-1)}`,
    displayName: `Smoke Account ${id.slice(-1)}`,
    bio: 'fictional smoke account',
    profileImageUrl: null,
    followersCount: 10,
    followingCount: 5,
    tweetCount: 3,
    accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
    location: null,
    url: null,
    isBlueVerified: false,
    verifiedType: null,
    professionalType: null,
    parodyCommentaryFanLabel: null,
    ...overrides,
  }
}

function makeTweet(id: string, accountId: string, createdAt: Date): TweetInput {
  return {
    id,
    accountId,
    fullText: `fictional smoke tweet ${id}`,
    createdAt,
    retweetCount: 1,
    likeCount: 2,
    replyCount: 0,
    quoteCount: 0,
    isReply: false,
    inReplyToTweetId: null,
    isAuthorReply: false,
    isRetweet: false,
    retweetedTweetId: null,
    isPromoted: false,
    isPaidPromotion: false,
    hasMedia: false,
    conversationId: null,
    hasAiGeneratedMedia: null,
    aiGeneratedDetectionSource: null,
    foreignVideoSourceCount: null,
    quotedTweetId: null,
    quotedTweetAuthorId: null,
    quotedTweetHasVideo: null,
    source: 'recommended',
  }
}

describe.skipIf(!enabled)('DB rebuild smoke: crawler persistence and relabel cycle', () => {
  const prisma = getPrismaClient()

  it('persists accounts and tweets, then a relabel cycle writes sparse label state', async () => {
    await upsertAccount(prisma, makeAccount(ALICE, { isBlueVerified: true }))
    await upsertAccount(prisma, makeAccount(BOB, {}))
    await upsertAccount(
      prisma,
      makeAccount(CAROL, { isBlueVerified: true, verifiedType: 'Business' }),
    )

    const base = new Date('2026-11-01T00:00:00Z').getTime()
    const tweets: TweetInput[] = []
    for (const [accountIndex, accountId] of [ALICE, BOB, CAROL].entries()) {
      for (let n = 0; n < 5; n++) {
        tweets.push(
          makeTweet(
            `191000000000000${String(accountIndex)}${String(n).padStart(3, '0')}`,
            accountId,
            new Date(base + n * 3_600_000),
          ),
        )
      }
    }
    await upsertTweets(prisma, tweets)
    for (const accountId of [ALICE, BOB, CAROL]) {
      await recordRecentTweetsFetchSuccess(prisma, accountId, new Date('2026-11-02T00:00:00Z'))
    }

    // ID 単独の検索 (パーティション全走査を避ける索引経路) と、アカウント指定の直近取得。
    const missing = await findMissingTweetIds(prisma, [tweets[0].id, '1919999999999999999'])
    expect(missing).toEqual(['1919999999999999999'])
    const contexts = await findTweetContextsByIds(prisma, [tweets[0].id])
    expect(contexts.get(tweets[0].id)?.accountId).toBe(ALICE)
    const recent = await loadRecentTweetsForAccounts(prisma, [ALICE], 3)
    const aliceRecent = recent.get(ALICE) ?? []
    expect(aliceRecent.map((tweet) => tweet.id)).toEqual([
      '1910000000000000004',
      '1910000000000000003',
      '1910000000000000002',
    ])

    // relabeler は storage-guard の計測が古い (または無い) と止まる。計測済みの状態を用意する。
    await prisma.storageCapacityState.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', availableGib: 500, usedPercent: 10, measuredAt: new Date() },
      update: { availableGib: 500, usedPercent: 10, measuredAt: new Date(), relabelBlocked: false },
    })

    await runRelabelWorkerCycleOnce(prisma)

    const states = await prisma.accountLabelState.findMany({ orderBy: { accountId: 'asc' } })
    expect(states.map((state) => state.accountId)).toEqual([ALICE, BOB, CAROL])
    const definitionCount = await prisma.labelDefinition.count()
    for (const state of states) {
      expect(state.rev).toBeGreaterThanOrEqual(1)
      expect(state.versions.length).toBeGreaterThanOrEqual(definitionCount)
    }

    const active = await prisma.accountActiveLabel.findMany({
      orderBy: [{ accountId: 'asc' }, { labelDefinitionId: 'asc' }],
    })
    const definitions = await prisma.labelDefinition.findMany()
    const keyById = new Map(definitions.map((definition) => [definition.id, definition.key]))
    const activeKeys = (accountId: string): string[] =>
      active
        .filter((row) => row.accountId === accountId)
        .map((row) => keyById.get(row.labelDefinitionId) ?? '')
        .toSorted()
    expect(activeKeys(ALICE)).toContain('verified_blue_individual')
    expect(activeKeys(BOB)).not.toContain('verified_blue_individual')
    expect(activeKeys(CAROL)).toContain('verified_business')
    expect(activeKeys(CAROL)).not.toContain('verified_blue_individual')

    // 監査トリガーが、true になったラベルごとに added を 1 件ずつ記録している。
    const added = await prisma.accountLabelChange.groupBy({
      by: ['accountId'],
      where: { changeType: 'added' },
      _count: { _all: true },
    })
    for (const accountId of [ALICE, BOB, CAROL]) {
      const expected = active.filter((row) => row.accountId === accountId).length
      const actual = added.find((row) => row.accountId === accountId)?._count._all ?? 0
      expect(actual).toBe(expected)
    }

    // 2 周目は何も変えず、rev も監査行も増えない (同値の書き込みは遷移として記録しない)。
    const changeCount = await prisma.accountLabelChange.count()
    await runRelabelWorkerCycleOnce(prisma)
    expect(await prisma.accountLabelChange.count()).toBe(changeCount)

    // crawl 経路: 同じ評価結果を crawl のアトミックな書き込みで流すと、
    // 値が変わらないため監査行は増えず、observation と analyzer 向けの work item だけが作られる。
    const crawlRun = await prisma.crawlRun.create({
      data: {
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        status: 'running',
      },
    })
    const blueId = [...keyById.entries()].find(([, key]) => key === 'verified_blue_individual')?.[0]
    if (blueId === undefined) throw new Error('label verified_blue_individual is not defined')
    const observationId = await recordCrawlAccountLabelsAtomic(prisma, {
      accountId: ALICE,
      crawlRunId: crawlRun.id,
      username: 'smoke_crawler',
      labels: [
        {
          labelDefinitionId: blueId,
          result: { value: true, confidence: 1, reason: 'smoke' },
          method: 'rule',
          ruleVersion: verifiedBlueIndividualRule.version,
        },
      ],
    })
    if (observationId === null) throw new Error('no observation was recorded')
    const observation = await prisma.accountClassificationObservation.findUniqueOrThrow({
      where: { id: observationId },
    })
    expect(observation.accountId).toBe(ALICE)
    expect(await prisma.accountLabelChange.count()).toBe(changeCount)
    const queued = await prisma.analysisWorkItem.count({
      where: {
        kind: 'account_summary_refresh',
        triggerType: 'account_classification_observation',
        triggerId: observationId,
        status: 'queued',
      },
    })
    expect(queued).toBe(1)
  }, 120_000)
})
