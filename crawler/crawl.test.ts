import { Logger } from '@book000/node-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runCrawlCycle, type CrawlDependencies } from './crawl'
import type { CrawlAccountCheckpointParams } from './db/crawl-run-repository'
import { LabelRuleRegistry } from './labels/registry'
import { ALL_LABEL_RULES } from './labels/all-rules'

const { captureMessageMock } = vi.hoisted(() => ({ captureMessageMock: vi.fn() }))
vi.mock('./monitoring/sentry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./monitoring/sentry')>()),
  captureMessage: captureMessageMock,
}))

function rawUser(restId: string, screenName = 'someone') {
  return {
    restId,
    legacy: {
      screenName,
      name: 'Someone',
      description: null,
      followersCount: 1,
      friendsCount: 1,
      statusesCount: 1,
      createdAt: 'Wed Jan 01 00:00:00 +0000 2020',
      profileImageUrlHttps: null,
      location: null,
      url: null,
    },
    isBlueVerified: true,
    verifiedType: null,
  }
}

function rawTweet(
  id: string,
  user: ReturnType<typeof rawUser>,
  inReplyToStatusIdStr: string | null = null,
  overrides: {
    isPromoted?: boolean
    isPaidPromotion?: boolean
    fullText?: string
    inReplyToStatusIdStr?: string
  } = {},
) {
  return {
    restId: id,
    legacy: {
      fullText: overrides.fullText ?? 'hello',
      createdAt: 'Wed Jan 01 00:00:00 +0000 2020',
      retweetCount: 5,
      favoriteCount: 5,
      replyCount: 0,
      quoteCount: 0,
      inReplyToStatusIdStr: overrides.inReplyToStatusIdStr ?? inReplyToStatusIdStr,
      retweetedStatusIdStr: null,
      isPromoted: overrides.isPromoted,
      isPaidPromotion: overrides.isPaidPromotion,
    },
    user,
  }
}

function responseError(status: number, headers: Headers = new Headers()): Error {
  const error = new Error('Response returned an error code')
  error.name = 'ResponseError'
  ;(error as unknown as { response: { status: number; headers: Headers; body: string } }).response =
    {
      status,
      headers,
      body: 'diagnostic-test-response-body',
    }
  return error
}

function makeDeps(overrides: Partial<CrawlDependencies> = {}): CrawlDependencies {
  const author = rawUser('author1')
  const tweet = rawTweet('tweet1', author)
  const emptyFollowPage = { data: [], nextCursor: undefined }

  return {
    config: {
      accounts: [{ email: 'a@example.com', username: 'v', password: 'p', otpSecret: null }],
    },
    limits: {
      tweetsPerTimeline: 100,
      repliesPerTweet: 30,
      recentTweetsPerAccount: 20,
      topTweetsForReplies: 30,
      trendsPerCycle: 5,
      followEdgesPerAccount: 2000,
      authorFetchDelayMs: 300,
    },
    issueCookies: vi.fn().mockResolvedValue({ ct0: 'c0', authToken: 'a0' }),
    createOpenApiClient: vi.fn().mockResolvedValue({
      client: {
        getTweetApi: () => ({
          getHomeTimeline: vi.fn().mockResolvedValue({ data: { data: [tweet] } }),
          getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
          getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
          getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
        }),
        getUserApi: () => ({
          getUserByRestId: vi.fn().mockResolvedValue({ data: author }),
          getUserByScreenName: vi.fn().mockResolvedValue({ data: rawUser('viewer1', 'v') }),
          getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
        }),
        getUserListApi: () => ({
          getFollowing: vi.fn().mockResolvedValue(emptyFollowPage),
          getFollowers: vi.fn().mockResolvedValue(emptyFollowPage),
        }),
      },
    }),
    closeOpenApiClient: vi.fn().mockResolvedValue(undefined),
    createTrendsScraper: vi
      .fn()
      .mockResolvedValue({ scraper: { getTrends: vi.fn().mockResolvedValue([]) } }),
    closeTrendsScraper: vi.fn().mockResolvedValue(undefined),
    persistAccount: vi.fn().mockResolvedValue(undefined),
    persistTweets: vi.fn().mockResolvedValue(undefined),
    ensureLabelDefinitions: vi
      .fn()
      .mockResolvedValue(new Map([['verified_blue_individual', 'ld1']])),
    loadReplyCorpus: vi.fn().mockResolvedValue([]),
    persistLabel: vi.fn().mockResolvedValue(undefined),
    syncFollowing: vi.fn().mockResolvedValue(undefined),
    syncFollowers: vi.fn().mockResolvedValue(undefined),
    startOrResumeCrawlRun: vi.fn().mockResolvedValue({
      id: 'run1',
      latestAccountStatuses: new Map(),
    }),
    finishCrawlRun: vi.fn().mockResolvedValue(undefined),
    recordCrawlAccountRun: vi.fn().mockResolvedValue(undefined),
    loadCrawlAccountCheckpoints: vi.fn().mockResolvedValue(new Map()),
    completeCrawlAccountCheckpoint: vi.fn().mockResolvedValue(undefined),
    clearCrawlAccountCheckpoints: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('runCrawlCycle', () => {
  beforeEach(() => {
    captureMessageMock.mockClear()
  })

  it('runs the full pipeline for the configured account and persists results', async () => {
    const deps = makeDeps()

    await runCrawlCycle(deps)

    expect(deps.issueCookies).toHaveBeenCalledWith({
      username: 'v',
      password: 'p',
      otp_secret: null,
    })
    expect(deps.persistAccount).toHaveBeenCalled()
    expect(deps.persistTweets).toHaveBeenCalled()
    expect(deps.persistLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        crawlRunId: 'run1',
        username: 'v',
        accountId: 'author1',
        labelDefinitionId: 'ld1',
      }),
    )
    expect(deps.closeTrendsScraper).toHaveBeenCalled()
    expect(deps.closeOpenApiClient).toHaveBeenCalled()
  })

  it('passes the registry to ensureLabelDefinitions so every registered rule gets a LabelDefinition', async () => {
    const deps = makeDeps()
    await runCrawlCycle(deps)
    expect(deps.ensureLabelDefinitions).toHaveBeenCalledWith(expect.any(LabelRuleRegistry))
  })

  it('registers exactly the same rule keys as ALL_LABEL_RULES, so seeding and crawling never drift apart', async () => {
    let registeredKeys: string[] = []
    const deps = makeDeps({
      ensureLabelDefinitions: vi.fn().mockImplementation((registry: LabelRuleRegistry) => {
        registeredKeys = registry.getAll().map((rule) => rule.key)
        return Promise.resolve(new Map(registeredKeys.map((key) => [key, `${key}-id`])))
      }),
    })

    await runCrawlCycle(deps)

    expect(new Set(registeredKeys)).toEqual(new Set(ALL_LABEL_RULES.map((rule) => rule.key)))
  })

  it('still closes the trends scraper and open API client if a later step throws', async () => {
    const deps = makeDeps({ persistTweets: vi.fn().mockRejectedValue(new Error('db down')) })

    await runCrawlCycle(deps)

    expect(deps.closeTrendsScraper).toHaveBeenCalled()
    expect(deps.closeOpenApiClient).toHaveBeenCalled()
  })

  it('upserts third-party authors found only in replies before persisting tweets', async () => {
    const author = rawUser('author1')
    const replyAuthor = rawUser('reply-author', 'replier')
    const tweet = rawTweet('tweet1', author)
    const reply = rawTweet('reply1', replyAuthor, 'tweet1')

    const getUserByRestId = vi
      .fn()
      .mockImplementation(({ userId }: { userId: string }) =>
        Promise.resolve({ data: userId === 'reply-author' ? replyAuthor : author }),
      )

    const deps = makeDeps({
      createOpenApiClient: vi.fn().mockResolvedValue({
        client: {
          getTweetApi: () => ({
            getHomeTimeline: vi.fn().mockResolvedValue({ data: { data: [tweet] } }),
            getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [reply] } }),
          }),
          getUserApi: () => ({
            getUserByRestId,
            getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
        },
      }),
    })

    await runCrawlCycle(deps)

    expect(deps.persistAccount).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'reply-author' }),
    )
    const persistAccountCalls = (deps.persistAccount as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => (call[0] as { id: string }).id,
    )
    const persistTweetsCallOrder = (deps.persistTweets as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]
    const replyAuthorCallOrder = (deps.persistAccount as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[persistAccountCalls.indexOf('reply-author')]
    expect(replyAuthorCallOrder).toBeLessThan(persistTweetsCallOrder)
    expect(deps.persistTweets).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'reply1', accountId: 'reply-author' }),
      ]),
    )
  })

  it("evaluates and persists labels for a third-party account that only hijacks replies on someone else's high-engagement tweet", async () => {
    const author = rawUser('author1')
    const replyAuthor = rawUser('reply-author', 'replier')
    const tweet = rawTweet('tweet1', author)
    const reply = rawTweet('reply1', replyAuthor, 'tweet1')

    const getUserByRestId = vi
      .fn()
      .mockImplementation(({ userId }: { userId: string }) =>
        Promise.resolve({ data: userId === 'reply-author' ? replyAuthor : author }),
      )

    const deps = makeDeps({
      ensureLabelDefinitions: vi
        .fn()
        .mockResolvedValue(new Map([['ad_reply_hijack', 'ld-hijack']])),
      createOpenApiClient: vi.fn().mockResolvedValue({
        client: {
          getTweetApi: () => ({
            getHomeTimeline: vi.fn().mockResolvedValue({ data: { data: [tweet] } }),
            getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [reply] } }),
          }),
          getUserApi: () => ({
            getUserByRestId,
            getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
        },
      }),
    })

    await runCrawlCycle(deps)

    // The reply-hijack candidate must go through the same dedicated profile fetch and
    // label evaluation as any timeline author - not just the lighter embedded-profile
    // upsert fallback used for authors we never evaluate.
    expect(getUserByRestId).toHaveBeenCalledWith({ userId: 'reply-author' })
    expect(deps.persistLabel).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'reply-author', labelDefinitionId: 'ld-hijack' }),
    )
  })

  it("evaluates ad_reply_hijack as true using the actual observed hijack replies, not a separately-fetched, unrelated slice of the candidate's own tweet history", async () => {
    const author = rawUser('author1')
    const replyAuthor = rawUser('reply-author', 'replier')
    const tweet = rawTweet('tweet1', author)
    const hijackReplies = [
      rawTweet('reply1', replyAuthor, 'tweet1', { fullText: 'giveaway! connect wallet now' }),
      rawTweet('reply2', replyAuthor, 'tweet1', { fullText: 'free mint, claim now' }),
      rawTweet('reply3', replyAuthor, 'tweet1', { fullText: 'airdrop for early replies' }),
    ]

    const getUserByRestId = vi
      .fn()
      .mockImplementation(({ userId }: { userId: string }) =>
        Promise.resolve({ data: userId === 'reply-author' ? replyAuthor : author }),
      )

    const deps = makeDeps({
      ensureLabelDefinitions: vi
        .fn()
        .mockResolvedValue(new Map([['ad_reply_hijack', 'ld-hijack']])),
      createOpenApiClient: vi.fn().mockResolvedValue({
        client: {
          getTweetApi: () => ({
            getHomeTimeline: vi.fn().mockResolvedValue({ data: { data: [tweet] } }),
            getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getTweetDetail: vi.fn().mockResolvedValue({ data: { data: hijackReplies } }),
          }),
          getUserApi: () => ({
            getUserByRestId,
            // Deliberately empty: the candidate's own recent-tweets fetch returns
            // nothing, so the only path by which their label evaluation can see the
            // hijack replies is via the otherReplies observed above.
            getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
        },
      }),
    })

    await runCrawlCycle(deps)

    expect(deps.persistLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'reply-author',
        labelDefinitionId: 'ld-hijack',
        result: expect.objectContaining({ value: true }),
      }),
    )
  })

  it('attaches templatedReplyNetworkSize to the bundle, computed from the loaded reply corpus', async () => {
    const author = rawUser('author1')
    const tweet = rawTweet('tweet1', author)
    const templatedReply = rawTweet('own-reply', author, 'tweet1', {
      fullText: 'this exact templated reply text appears everywhere',
    })

    const applyAllSpy = vi.spyOn(LabelRuleRegistry.prototype, 'applyAll')

    const deps = makeDeps({
      loadReplyCorpus: vi.fn().mockResolvedValue([
        { accountId: 'other1', fullText: 'this exact templated reply text appears everywhere' },
        { accountId: 'other2', fullText: 'this exact templated reply text appears everywhere' },
      ]),
      createOpenApiClient: vi.fn().mockResolvedValue({
        client: {
          getTweetApi: () => ({
            getHomeTimeline: vi.fn().mockResolvedValue({ data: { data: [tweet] } }),
            getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserApi: () => ({
            getUserByRestId: vi.fn().mockResolvedValue({ data: author }),
            getUserTweetsAndReplies: vi
              .fn()
              .mockResolvedValue({ data: { data: [templatedReply] } }),
          }),
        },
      }),
    })

    await runCrawlCycle(deps)

    const bundleForAuthor = applyAllSpy.mock.calls
      .map((call) => call[0])
      .find((bundle) => bundle.account.id === 'author1')
    expect(bundleForAuthor?.templatedReplyNetworkSize).toBe(2)

    applyAllSpy.mockRestore()
  })

  it('attaches replyHijackSwarmSize to the bundle, computed from the loaded reply corpus', async () => {
    const author = rawUser('author1')
    const tweet = rawTweet('tweet1', author)
    const ownReply = rawTweet('own-reply', author, 'tweet1', {
      fullText: 'このサンプル動画は視聴する価値が十分にあると思いますね',
      inReplyToStatusIdStr: 'swarm-target',
    })

    const applyAllSpy = vi.spyOn(LabelRuleRegistry.prototype, 'applyAll')

    const now = Date.now()
    const deps = makeDeps({
      loadReplyCorpus: vi.fn().mockResolvedValue([
        {
          // swarmSizeFor (see labels/reply-hijack-index.ts) only counts an account as a
          // swarm member if its own reply is present in the loaded corpus - the account
          // being labeled in this test is no exception, so its reply must be included
          // here too, not just returned live via getUserTweetsAndReplies below.
          accountId: 'author1',
          fullText: 'このサンプル動画は視聴する価値が十分にあると思いますね',
          inReplyToTweetId: 'swarm-target',
          createdAt: new Date(now),
        },
        {
          accountId: 'other1',
          fullText: 'このサンプル動画は視聴する価値が十分にありましたよ',
          inReplyToTweetId: 'swarm-target',
          createdAt: new Date(now),
        },
        {
          accountId: 'other2',
          fullText: 'サンプル動画は視聴する価値が十分にあると思いました',
          inReplyToTweetId: 'swarm-target',
          createdAt: new Date(now),
        },
        {
          accountId: 'other3',
          fullText: 'このサンプル動画は視聴する価値が十分にある内容ですね',
          inReplyToTweetId: 'swarm-target',
          createdAt: new Date(now),
        },
        {
          accountId: 'other4',
          fullText: 'このサンプル動画は視聴する価値が十分にあった感じですね',
          inReplyToTweetId: 'swarm-target',
          createdAt: new Date(now),
        },
      ]),
      createOpenApiClient: vi.fn().mockResolvedValue({
        client: {
          getTweetApi: () => ({
            getHomeTimeline: vi.fn().mockResolvedValue({ data: { data: [tweet] } }),
            getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserApi: () => ({
            getUserByRestId: vi.fn().mockResolvedValue({ data: author }),
            getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [ownReply] } }),
          }),
        },
      }),
    })

    await runCrawlCycle(deps)

    const bundleForAuthor = applyAllSpy.mock.calls
      .map((call) => call[0])
      .find((bundle) => bundle.account.id === 'author1')
    expect(bundleForAuthor?.replyHijackSwarmSize).toBe(5)

    applyAllSpy.mockRestore()
  })

  it('continues to the next account if one account throws', async () => {
    const config = {
      accounts: [
        { email: 'a@example.com', username: 'first', password: 'p', otpSecret: null },
        { email: 'b@example.com', username: 'second', password: 'p', otpSecret: null },
      ],
    }
    const issueCookies = vi
      .fn()
      .mockRejectedValueOnce(new Error('auth failed'))
      .mockResolvedValueOnce({ ct0: 'c0', authToken: 'a0' })
    const deps = makeDeps({ config, issueCookies })

    await runCrawlCycle(deps)

    expect(issueCookies).toHaveBeenCalledTimes(2)
    expect(deps.persistTweets).toHaveBeenCalledTimes(1)
  })

  it('skips an author whose profile fetch throws but still persists the other authors and all tweets', async () => {
    const authorOk = rawUser('author-ok')
    const authorBad = rawUser('author-bad')
    const tweetOk = rawTweet('tweet-ok', authorOk)
    const tweetBad = rawTweet('tweet-bad', authorBad)

    const getUserByRestId = vi.fn().mockImplementation(({ userId }: { userId: string }) => {
      if (userId === 'author-bad') return Promise.reject(new Error('User not found'))
      return Promise.resolve({ data: authorOk })
    })

    const deps = makeDeps({
      createOpenApiClient: vi.fn().mockResolvedValue({
        client: {
          getTweetApi: () => ({
            getHomeTimeline: vi.fn().mockResolvedValue({ data: { data: [tweetOk, tweetBad] } }),
            getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserApi: () => ({
            getUserByRestId,
            getUserByScreenName: vi.fn().mockResolvedValue({ data: rawUser('viewer1', 'v') }),
            getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserListApi: () => ({
            getFollowing: vi.fn().mockResolvedValue({ data: [], nextCursor: undefined }),
            getFollowers: vi.fn().mockResolvedValue({ data: [], nextCursor: undefined }),
          }),
        },
      }),
    })

    await runCrawlCycle(deps)

    // author-ok gets the full, dedicated-fetch profile persisted...
    expect(deps.persistAccount).toHaveBeenCalledWith(expect.objectContaining({ id: 'author-ok' }))
    // ...author-bad's dedicated fetch failed, but its embedded timeline profile is still
    // persisted as a fallback, since tweet-bad's accountId FK requires an Account row.
    expect(deps.persistAccount).toHaveBeenCalledWith(expect.objectContaining({ id: 'author-bad' }))
    expect(deps.persistTweets).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'tweet-ok' }),
        expect.objectContaining({ id: 'tweet-bad' }),
      ]),
    )
    expect(deps.recordCrawlAccountRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success', warnings: [] }),
    )
    expect(deps.finishCrawlRun).toHaveBeenCalledWith('run1', expect.any(Date), 'success')
  })

  it('merges a timeline-only promoted tweet into the label bundle for its author', async () => {
    const author = rawUser('author1')
    const promotedTweet = rawTweet('promoted1', author, null, {
      isPromoted: true,
      isPaidPromotion: true,
    })

    const applyAllSpy = vi.spyOn(LabelRuleRegistry.prototype, 'applyAll')

    const deps = makeDeps({
      createOpenApiClient: vi.fn().mockResolvedValue({
        client: {
          getTweetApi: () => ({
            getHomeTimeline: vi.fn().mockResolvedValue({ data: { data: [promotedTweet] } }),
            getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserApi: () => ({
            getUserByRestId: vi.fn().mockResolvedValue({ data: author }),
            // The author's own tweet list (profile fetch) never carries this tweet -
            // it is only ever observed via the timeline injection above.
            getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
        },
      }),
    })

    await runCrawlCycle(deps)

    const bundleForAuthor = applyAllSpy.mock.calls
      .map((call) => call[0])
      .find((bundle) => bundle.account.id === 'author1')
    expect(bundleForAuthor?.recentTweets).toContainEqual(
      expect.objectContaining({ id: 'promoted1', isPromoted: true, isPaidPromotion: true }),
    )

    applyAllSpy.mockRestore()
  })

  it('does not let a profile-fetched copy overwrite a true isPromoted/isPaidPromotion flag observed via the timeline', async () => {
    const author = rawUser('author1')
    const promotedInTimeline = rawTweet('shared1', author, null, {
      isPromoted: true,
      isPaidPromotion: true,
    })
    const notPromotedInProfile = rawTweet('shared1', author, null, {
      isPromoted: false,
      isPaidPromotion: false,
    })

    const applyAllSpy = vi.spyOn(LabelRuleRegistry.prototype, 'applyAll')

    const deps = makeDeps({
      createOpenApiClient: vi.fn().mockResolvedValue({
        client: {
          getTweetApi: () => ({
            getHomeTimeline: vi.fn().mockResolvedValue({ data: { data: [promotedInTimeline] } }),
            getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserApi: () => ({
            getUserByRestId: vi.fn().mockResolvedValue({ data: author }),
            // Same tweet id as observed in the timeline above, but the profile fetch
            // path never carries a true isPromoted/isPaidPromotion flag.
            getUserTweetsAndReplies: vi
              .fn()
              .mockResolvedValue({ data: { data: [notPromotedInProfile] } }),
          }),
        },
      }),
    })

    await runCrawlCycle(deps)

    const bundleForAuthor = applyAllSpy.mock.calls
      .map((call) => call[0])
      .find((bundle) => bundle.account.id === 'author1')
    expect(bundleForAuthor?.recentTweets).toContainEqual(
      expect.objectContaining({ id: 'shared1', isPromoted: true, isPaidPromotion: true }),
    )

    applyAllSpy.mockRestore()
  })

  it('excludes a foreign author tweet returned by getUserTweetsAndReplies (reply-thread context) from the author label bundle, while still persisting it under its own author', async () => {
    const author = rawUser('author1')
    const stranger = rawUser('stranger1', 'stranger')
    const timelineTweet = rawTweet('timeline1', author)
    const ownReply = rawTweet('own-reply1', author, 'parent1')
    // Twitter's UserTweetsAndReplies endpoint returns the parent tweet a reply answers
    // as conversation-thread context alongside the account's own posts, even though it
    // is authored by someone else entirely.
    const foreignParentTweet = rawTweet('parent1', stranger)

    const applyAllSpy = vi.spyOn(LabelRuleRegistry.prototype, 'applyAll')

    const deps = makeDeps({
      createOpenApiClient: vi.fn().mockResolvedValue({
        client: {
          getTweetApi: () => ({
            getHomeTimeline: vi.fn().mockResolvedValue({ data: { data: [timelineTweet] } }),
            getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserApi: () => ({
            getUserByRestId: vi.fn().mockResolvedValue({ data: author }),
            getUserTweetsAndReplies: vi
              .fn()
              .mockResolvedValue({ data: { data: [ownReply, foreignParentTweet] } }),
          }),
        },
      }),
    })

    await runCrawlCycle(deps)

    const bundleForAuthor = applyAllSpy.mock.calls
      .map((call) => call[0])
      .find((bundle) => bundle.account.id === 'author1')
    expect(bundleForAuthor?.recentTweets).toContainEqual(
      expect.objectContaining({ id: 'own-reply1' }),
    )
    expect(bundleForAuthor?.recentTweets).not.toContainEqual(
      expect.objectContaining({ id: 'parent1' }),
    )
    expect(deps.persistTweets).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'parent1', accountId: 'stranger1' })]),
    )

    applyAllSpy.mockRestore()
  })

  it('does not let a profile-fetched duplicate overwrite a true isPromoted/isPaidPromotion flag in the batch persisted to the DB', async () => {
    const author = rawUser('author1')
    const promotedInTimeline = rawTweet('shared1', author, null, {
      isPromoted: true,
      isPaidPromotion: true,
    })
    const notPromotedInProfile = rawTweet('shared1', author, null, {
      isPromoted: false,
      isPaidPromotion: false,
    })

    const deps = makeDeps({
      createOpenApiClient: vi.fn().mockResolvedValue({
        client: {
          getTweetApi: () => ({
            getHomeTimeline: vi.fn().mockResolvedValue({ data: { data: [promotedInTimeline] } }),
            getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserApi: () => ({
            getUserByRestId: vi.fn().mockResolvedValue({ data: author }),
            // Same tweet id as the timeline copy above, but the profile fetch path
            // never observes the ad-disclosure metadata, so it carries `false` here.
            getUserTweetsAndReplies: vi
              .fn()
              .mockResolvedValue({ data: { data: [notPromotedInProfile] } }),
          }),
        },
      }),
    })

    await runCrawlCycle(deps)

    const persistedBatch = (deps.persistTweets as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      id: string
      isPromoted: boolean
      isPaidPromotion: boolean
    }[]
    const sharedTweets = persistedBatch.filter((t) => t.id === 'shared1')
    expect(sharedTweets).toHaveLength(1)
    expect(sharedTweets[0]).toMatchObject({ isPromoted: true, isPaidPromotion: true })
  })

  it('resolves the login account own user id and syncs both following and followers', async () => {
    const getFollowing = vi
      .fn()
      .mockResolvedValue({ data: [rawUser('followee1')], nextCursor: undefined })
    const getFollowers = vi
      .fn()
      .mockResolvedValue({ data: [rawUser('follower1')], nextCursor: undefined })
    const getUserByScreenName = vi.fn().mockResolvedValue({ data: rawUser('viewer1', 'v') })

    const deps = makeDeps({
      createOpenApiClient: vi.fn().mockResolvedValue({
        client: {
          getTweetApi: () => ({
            getHomeTimeline: vi
              .fn()
              .mockResolvedValue({ data: { data: [rawTweet('tweet1', rawUser('author1'))] } }),
            getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserApi: () => ({
            getUserByRestId: vi.fn().mockResolvedValue({ data: rawUser('author1') }),
            getUserByScreenName,
            getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserListApi: () => ({ getFollowing, getFollowers }),
        },
      }),
    })

    await runCrawlCycle(deps)

    expect(getUserByScreenName).toHaveBeenCalledWith({ screenName: 'v' })
    expect(getFollowing).toHaveBeenCalledWith(expect.objectContaining({ userId: 'viewer1' }))
    expect(getFollowers).toHaveBeenCalledWith(expect.objectContaining({ userId: 'viewer1' }))
    expect(deps.syncFollowing).toHaveBeenCalledWith(
      'viewer1',
      expect.objectContaining({ ids: ['followee1'] }),
    )
    expect(deps.syncFollowers).toHaveBeenCalledWith(
      'viewer1',
      expect.objectContaining({ ids: ['follower1'] }),
    )
    expect(deps.persistAccount).toHaveBeenCalledWith(expect.objectContaining({ id: 'viewer1' }))
  })

  it('skips both follow/follower directions if resolving the own user id fails, without aborting the rest of the cycle', async () => {
    const getUserByScreenName = vi.fn().mockRejectedValue(new Error('user not found'))
    const deps = makeDeps({
      createOpenApiClient: vi.fn().mockResolvedValue({
        client: {
          getTweetApi: () => ({
            getHomeTimeline: vi
              .fn()
              .mockResolvedValue({ data: { data: [rawTweet('tweet1', rawUser('author1'))] } }),
            getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserApi: () => ({
            getUserByRestId: vi.fn().mockResolvedValue({ data: rawUser('author1') }),
            getUserByScreenName,
            getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserListApi: () => ({ getFollowing: vi.fn(), getFollowers: vi.fn() }),
        },
      }),
    })

    await runCrawlCycle(deps)

    expect(deps.syncFollowing).not.toHaveBeenCalled()
    expect(deps.syncFollowers).not.toHaveBeenCalled()
    expect(deps.persistTweets).toHaveBeenCalled()
    expect(deps.recordCrawlAccountRun).toHaveBeenCalledWith(
      expect.objectContaining({
        warnings: expect.arrayContaining([
          expect.objectContaining({
            type: 'own_account_sync_failed',
            username: 'v',
            errorMessage: 'user not found',
          }),
        ]),
      }),
    )
  })

  it('does not report to GlitchTip when warnings stay below the threshold', async () => {
    const originalThreshold = process.env.CRAWL_WARNING_THRESHOLD
    process.env.CRAWL_WARNING_THRESHOLD = '5'
    try {
      const getUserByScreenName = vi.fn().mockRejectedValue(new Error('user not found'))
      const deps = makeDeps({
        createOpenApiClient: vi.fn().mockResolvedValue({
          client: {
            getTweetApi: () => ({
              getHomeTimeline: vi
                .fn()
                .mockResolvedValue({ data: { data: [rawTweet('tweet1', rawUser('author1'))] } }),
              getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
              getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
              getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
            }),
            getUserApi: () => ({
              getUserByRestId: vi.fn().mockResolvedValue({ data: rawUser('author1') }),
              getUserByScreenName,
              getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
            }),
            getUserListApi: () => ({ getFollowing: vi.fn(), getFollowers: vi.fn() }),
          },
        }),
      })

      await runCrawlCycle(deps)

      expect(captureMessageMock).not.toHaveBeenCalled()
    } finally {
      if (originalThreshold === undefined) {
        delete process.env.CRAWL_WARNING_THRESHOLD
      } else {
        process.env.CRAWL_WARNING_THRESHOLD = originalThreshold
      }
    }
  })

  it('reports an aggregated summary to GlitchTip once warnings reach the threshold', async () => {
    const originalThreshold = process.env.CRAWL_WARNING_THRESHOLD
    process.env.CRAWL_WARNING_THRESHOLD = '1'
    try {
      const getUserByScreenName = vi.fn().mockRejectedValue(new Error('user not found'))
      const deps = makeDeps({
        createOpenApiClient: vi.fn().mockResolvedValue({
          client: {
            getTweetApi: () => ({
              getHomeTimeline: vi
                .fn()
                .mockResolvedValue({ data: { data: [rawTweet('tweet1', rawUser('author1'))] } }),
              getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
              getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
              getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
            }),
            getUserApi: () => ({
              getUserByRestId: vi.fn().mockResolvedValue({ data: rawUser('author1') }),
              getUserByScreenName,
              getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
            }),
            getUserListApi: () => ({ getFollowing: vi.fn(), getFollowers: vi.fn() }),
          },
        }),
      })

      await runCrawlCycle(deps)

      expect(captureMessageMock).toHaveBeenCalledTimes(1)
      expect(captureMessageMock).toHaveBeenCalledWith(
        'Crawl warnings threshold exceeded for v',
        expect.objectContaining({
          crawlRunId: 'run1',
          username: 'v',
          status: 'partial',
          appVersion: expect.any(String),
          warningCount: 1,
          warningThreshold: 1,
          warningCounts: { own_account_sync_failed: 1 },
        }),
      )
    } finally {
      if (originalThreshold === undefined) {
        delete process.env.CRAWL_WARNING_THRESHOLD
      } else {
        process.env.CRAWL_WARNING_THRESHOLD = originalThreshold
      }
    }
  })

  it('sums per-type counts separately when multiple warnings of the same type occur', async () => {
    const originalThreshold = process.env.CRAWL_WARNING_THRESHOLD
    process.env.CRAWL_WARNING_THRESHOLD = '1'
    try {
      const getUserByScreenName = vi.fn().mockRejectedValue(new Error('user not found'))
      const getUserByRestId = vi.fn().mockRejectedValue(new Error('profile fetch failed'))
      const deps = makeDeps({
        createOpenApiClient: vi.fn().mockResolvedValue({
          client: {
            getTweetApi: () => ({
              getHomeTimeline: vi.fn().mockResolvedValue({
                data: {
                  data: [
                    rawTweet('tweet1', rawUser('author1')),
                    rawTweet('tweet2', rawUser('author2')),
                  ],
                },
              }),
              getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
              getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
              getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
            }),
            getUserApi: () => ({
              getUserByRestId,
              getUserByScreenName,
              getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
            }),
            getUserListApi: () => ({ getFollowing: vi.fn(), getFollowers: vi.fn() }),
          },
        }),
      })

      await runCrawlCycle(deps)

      expect(captureMessageMock).toHaveBeenCalledTimes(1)
      expect(captureMessageMock).toHaveBeenCalledWith(
        'Crawl warnings threshold exceeded for v',
        expect.objectContaining({
          warningCount: 3,
          warningCounts: { author_processing_failed: 2, own_account_sync_failed: 1 },
        }),
      )
    } finally {
      if (originalThreshold === undefined) {
        delete process.env.CRAWL_WARNING_THRESHOLD
      } else {
        process.env.CRAWL_WARNING_THRESHOLD = originalThreshold
      }
    }
  })

  it('still syncs followers even if syncing following fails', async () => {
    const getFollowing = vi
      .fn()
      .mockResolvedValue({ data: [rawUser('followee1')], nextCursor: undefined })
    const getFollowers = vi
      .fn()
      .mockResolvedValue({ data: [rawUser('follower1')], nextCursor: undefined })
    const deps = makeDeps({
      syncFollowing: vi.fn().mockRejectedValue(new Error('db down')),
      createOpenApiClient: vi.fn().mockResolvedValue({
        client: {
          getTweetApi: () => ({
            getHomeTimeline: vi
              .fn()
              .mockResolvedValue({ data: { data: [rawTweet('tweet1', rawUser('author1'))] } }),
            getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserApi: () => ({
            getUserByRestId: vi.fn().mockResolvedValue({ data: rawUser('author1') }),
            getUserByScreenName: vi.fn().mockResolvedValue({ data: rawUser('viewer1', 'v') }),
            getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserListApi: () => ({ getFollowing, getFollowers }),
        },
      }),
    })

    await runCrawlCycle(deps)

    expect(deps.syncFollowers).toHaveBeenCalledWith(
      'viewer1',
      expect.objectContaining({ ids: ['follower1'] }),
    )
    expect(deps.recordCrawlAccountRun).toHaveBeenCalledWith(
      expect.objectContaining({
        warnings: expect.arrayContaining([
          expect.objectContaining({
            type: 'following_sync_failed',
            username: 'v',
            errorMessage: 'db down',
          }),
        ]),
      }),
    )
  })

  it('records a structured followers_sync_failed warning when syncing followers fails', async () => {
    const getFollowing = vi
      .fn()
      .mockResolvedValue({ data: [rawUser('followee1')], nextCursor: undefined })
    const getFollowers = vi
      .fn()
      .mockResolvedValue({ data: [rawUser('follower1')], nextCursor: undefined })
    const deps = makeDeps({
      syncFollowers: vi.fn().mockRejectedValue(new Error('followers db down')),
      createOpenApiClient: vi.fn().mockResolvedValue({
        client: {
          getTweetApi: () => ({
            getHomeTimeline: vi
              .fn()
              .mockResolvedValue({ data: { data: [rawTweet('tweet1', rawUser('author1'))] } }),
            getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserApi: () => ({
            getUserByRestId: vi.fn().mockResolvedValue({ data: rawUser('author1') }),
            getUserByScreenName: vi.fn().mockResolvedValue({ data: rawUser('viewer1', 'v') }),
            getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserListApi: () => ({ getFollowing, getFollowers }),
        },
      }),
    })

    await runCrawlCycle(deps)

    expect(deps.recordCrawlAccountRun).toHaveBeenCalledWith(
      expect.objectContaining({
        warnings: expect.arrayContaining([
          expect.objectContaining({
            type: 'followers_sync_failed',
            username: 'v',
            errorMessage: 'followers db down',
          }),
        ]),
      }),
    )
  })

  it('records a CrawlRun and one successful CrawlAccountRun for a clean cycle', async () => {
    const deps = makeDeps()

    await runCrawlCycle(deps)

    expect(deps.startOrResumeCrawlRun).toHaveBeenCalledWith(expect.any(Date))
    expect(deps.recordCrawlAccountRun).toHaveBeenCalledWith(
      expect.objectContaining({
        crawlRunId: 'run1',
        username: 'v',
        status: 'success',
        warnings: [],
        errorMessage: null,
      }),
    )
    expect(deps.finishCrawlRun).toHaveBeenCalledWith('run1', expect.any(Date), 'success')
    expect(deps.clearCrawlAccountCheckpoints).toHaveBeenCalledWith('run1')
  })

  it('resumes a run by retaining completed accounts and retrying all other configured accounts', async () => {
    const issueCookies = vi.fn().mockResolvedValue({ ct0: 'c0', authToken: 'a0' })
    const deps = makeDeps({
      config: {
        accounts: [
          { email: 'done@example.com', username: 'done', password: 'p', otpSecret: null },
          { email: 'partial@example.com', username: 'partial', password: 'p', otpSecret: null },
          { email: 'failed@example.com', username: 'failed', password: 'p', otpSecret: null },
          { email: 'unknown@example.com', username: 'unknown', password: 'p', otpSecret: null },
          { email: 'missing@example.com', username: 'missing', password: 'p', otpSecret: null },
        ],
      },
      issueCookies,
      startOrResumeCrawlRun: vi.fn().mockResolvedValue({
        id: 'resumed-run',
        latestAccountStatuses: new Map([
          ['done', 'success'],
          ['partial', 'partial'],
          ['failed', 'failed'],
          ['unknown', 'running'],
          ['removed-account', 'failed'],
        ]),
      }),
    })

    await runCrawlCycle(deps)

    expect(issueCookies).toHaveBeenCalledTimes(3)
    expect(issueCookies).toHaveBeenCalledWith(expect.objectContaining({ username: 'failed' }))
    expect(issueCookies).toHaveBeenCalledWith(expect.objectContaining({ username: 'unknown' }))
    expect(issueCookies).toHaveBeenCalledWith(expect.objectContaining({ username: 'missing' }))
    expect(deps.recordCrawlAccountRun).toHaveBeenCalledTimes(3)
    expect(deps.recordCrawlAccountRun).toHaveBeenCalledWith(
      expect.objectContaining({ crawlRunId: 'resumed-run', username: 'failed', status: 'success' }),
    )
    expect(deps.finishCrawlRun).toHaveBeenCalledWith('resumed-run', expect.any(Date), 'partial')
  })

  it('resumes author processing from the completed timeline snapshot without refetching timelines', async () => {
    const checkpoints = new Map<string, unknown>()
    const firstCycle = makeDeps({
      completeCrawlAccountCheckpoint: vi.fn((params: CrawlAccountCheckpointParams) => {
        checkpoints.set(params.phase, params.data)
        return Promise.resolve(undefined)
      }),
    })
    await runCrawlCycle(firstCycle)

    const getHomeTimeline = vi.fn()
    const getHomeLatestTimeline = vi.fn()
    const getSearchTimeline = vi.fn()
    const resumedCycle = makeDeps({
      loadCrawlAccountCheckpoints: vi
        .fn()
        .mockResolvedValue(new Map([['timelines', checkpoints.get('timelines')]])),
      createOpenApiClient: vi.fn().mockResolvedValue({
        client: {
          getTweetApi: () => ({
            getHomeTimeline,
            getHomeLatestTimeline,
            getSearchTimeline,
            getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserApi: () => ({
            getUserByRestId: vi.fn().mockResolvedValue({ data: rawUser('author1') }),
            getUserByScreenName: vi.fn().mockResolvedValue({ data: rawUser('viewer1', 'v') }),
            getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserListApi: () => ({
            getFollowing: vi.fn().mockResolvedValue({ data: [], nextCursor: undefined }),
            getFollowers: vi.fn().mockResolvedValue({ data: [], nextCursor: undefined }),
          }),
        },
      }),
    })

    await runCrawlCycle(resumedCycle)

    expect(getHomeTimeline).not.toHaveBeenCalled()
    expect(getHomeLatestTimeline).not.toHaveBeenCalled()
    expect(getSearchTimeline).not.toHaveBeenCalled()
    expect(resumedCycle.createTrendsScraper).not.toHaveBeenCalled()
    expect(resumedCycle.completeCrawlAccountCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'authors' }),
    )
  })

  it('refetches timelines when a stored timeline checkpoint is incomplete', async () => {
    const author = rawUser('author1')
    const getHomeTimeline = vi
      .fn()
      .mockResolvedValue({ data: { data: [rawTweet('tweet1', author)] } })
    const deps = makeDeps({
      loadCrawlAccountCheckpoints: vi.fn().mockResolvedValue(
        new Map([
          [
            'timelines',
            {
              recommended: {
                tweets: [
                  {
                    id: 'tweet1',
                    accountId: 'author1',
                    createdAt: '2026-01-01T00:00:00.000Z',
                  },
                ],
                authors: [],
              },
              following: { tweets: [], authors: [] },
              trending: { tweets: [], authors: [] },
              warnings: [],
            },
          ],
        ]),
      ),
      createOpenApiClient: vi.fn().mockResolvedValue({
        client: {
          getTweetApi: () => ({
            getHomeTimeline,
            getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserApi: () => ({
            getUserByRestId: vi.fn().mockResolvedValue({ data: author }),
            getUserByScreenName: vi.fn().mockResolvedValue({ data: rawUser('viewer1', 'v') }),
            getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserListApi: () => ({
            getFollowing: vi.fn().mockResolvedValue({ data: [], nextCursor: undefined }),
            getFollowers: vi.fn().mockResolvedValue({ data: [], nextCursor: undefined }),
          }),
        },
      }),
    })

    await runCrawlCycle(deps)

    expect(getHomeTimeline).toHaveBeenCalled()
    expect(deps.completeCrawlAccountCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'timelines' }),
    )
  })

  it('skips a completed following phase while resuming the followers phase', async () => {
    const checkpoints = new Map<string, unknown>()
    const firstCycle = makeDeps({
      completeCrawlAccountCheckpoint: vi.fn((params: CrawlAccountCheckpointParams) => {
        checkpoints.set(params.phase, params.data)
        return Promise.resolve(undefined)
      }),
    })
    await runCrawlCycle(firstCycle)

    const getFollowing = vi.fn()
    const getFollowers = vi
      .fn()
      .mockResolvedValue({ data: [rawUser('follower1')], nextCursor: undefined })
    const resumedCycle = makeDeps({
      loadCrawlAccountCheckpoints: vi.fn().mockResolvedValue(
        new Map([
          ['timelines', checkpoints.get('timelines')],
          ['authors', checkpoints.get('authors')],
          ['following', checkpoints.get('following')],
        ]),
      ),
      createOpenApiClient: vi.fn().mockResolvedValue({
        client: {
          getTweetApi: () => ({
            getHomeTimeline: vi.fn(),
            getHomeLatestTimeline: vi.fn(),
            getSearchTimeline: vi.fn(),
            getTweetDetail: vi.fn(),
          }),
          getUserApi: () => ({
            getUserByRestId: vi.fn(),
            getUserTweetsAndReplies: vi.fn(),
          }),
          getUserListApi: () => ({ getFollowing, getFollowers }),
        },
      }),
    })

    await runCrawlCycle(resumedCycle)

    expect(getFollowing).not.toHaveBeenCalled()
    expect(resumedCycle.syncFollowing).not.toHaveBeenCalled()
    expect(getFollowers).toHaveBeenCalledWith({ userId: 'viewer1', cursor: undefined, count: 200 })
    expect(resumedCycle.completeCrawlAccountCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'followers' }),
    )
    expect(resumedCycle.createTrendsScraper).not.toHaveBeenCalled()
  })

  it('marks the CrawlRun as failed and rethrows when finishCrawlRun itself fails', async () => {
    const dbError = new Error('db unavailable')
    const finishCrawlRun = vi.fn().mockRejectedValueOnce(dbError).mockResolvedValueOnce(undefined)
    const deps = makeDeps({ finishCrawlRun })

    await expect(runCrawlCycle(deps)).rejects.toThrow(dbError)

    expect(finishCrawlRun).toHaveBeenNthCalledWith(1, 'run1', expect.any(Date), 'success')
    expect(finishCrawlRun).toHaveBeenNthCalledWith(2, 'run1', expect.any(Date), 'failed')
  })

  it('rethrows the original error, not the recovery failure, when finishCrawlRun fails both times', async () => {
    const originalError = new Error('db unavailable')
    const recoveryError = new Error('db still unavailable')
    const finishCrawlRun = vi
      .fn()
      .mockRejectedValueOnce(originalError)
      .mockRejectedValueOnce(recoveryError)
    const deps = makeDeps({ finishCrawlRun })

    await expect(runCrawlCycle(deps)).rejects.toThrow(originalError)

    expect(finishCrawlRun).toHaveBeenNthCalledWith(1, 'run1', expect.any(Date), 'success')
    expect(finishCrawlRun).toHaveBeenNthCalledWith(2, 'run1', expect.any(Date), 'failed')
  })

  it('records a partial CrawlAccountRun with a warning when a timeline fetch fails', async () => {
    const deps = makeDeps({
      createOpenApiClient: vi.fn().mockResolvedValue({
        client: {
          getTweetApi: () => ({
            getHomeTimeline: vi.fn().mockRejectedValue(new Error('rate limited')),
            getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserApi: () => ({
            getUserByRestId: vi.fn().mockResolvedValue({ data: rawUser('author1') }),
            getUserByScreenName: vi.fn().mockResolvedValue({ data: rawUser('viewer1', 'v') }),
            getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserListApi: () => ({
            getFollowing: vi.fn().mockResolvedValue({ data: [], nextCursor: undefined }),
            getFollowers: vi.fn().mockResolvedValue({ data: [], nextCursor: undefined }),
          }),
        },
      }),
    })

    await runCrawlCycle(deps)

    expect(deps.recordCrawlAccountRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'partial',
        warnings: expect.arrayContaining([
          expect.objectContaining({
            type: 'recommended_timeline_failed',
            username: 'v',
            errorMessage: 'rate limited',
          }),
        ]),
      }),
    )
    expect(deps.finishCrawlRun).toHaveBeenCalledWith('run1', expect.any(Date), 'partial')
  })

  it('records a structured author_processing_failed warning when an author fails for a non-routine reason', async () => {
    const authorOk = rawUser('author-ok')
    const authorBad = rawUser('author-bad')
    const tweetOk = rawTweet('tweet-ok', authorOk)
    const tweetBad = rawTweet('tweet-bad', authorBad)

    const getUserByRestId = vi.fn().mockImplementation(({ userId }: { userId: string }) => {
      if (userId === 'author-bad') return Promise.reject(new Error('db unavailable'))
      return Promise.resolve({ data: authorOk })
    })

    const deps = makeDeps({
      createOpenApiClient: vi.fn().mockResolvedValue({
        client: {
          getTweetApi: () => ({
            getHomeTimeline: vi.fn().mockResolvedValue({ data: { data: [tweetOk, tweetBad] } }),
            getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserApi: () => ({
            getUserByRestId,
            getUserByScreenName: vi.fn().mockResolvedValue({ data: rawUser('viewer1', 'v') }),
            getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserListApi: () => ({
            getFollowing: vi.fn().mockResolvedValue({ data: [], nextCursor: undefined }),
            getFollowers: vi.fn().mockResolvedValue({ data: [], nextCursor: undefined }),
          }),
        },
      }),
    })

    await runCrawlCycle(deps)

    expect(deps.recordCrawlAccountRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'partial',
        warnings: expect.arrayContaining([
          expect.objectContaining({
            type: 'author_processing_failed',
            authorId: 'author-bad',
            errorMessage: 'db unavailable',
          }),
        ]),
      }),
    )
  })

  it.each([401, 403, 429, 500])(
    'records safe HTTP diagnostics and a partial run for author ResponseError %i',
    async (status) => {
      const author = rawUser('author1')
      const tweet = rawTweet('tweet1', author)
      const error = responseError(
        status,
        new Headers({
          'Retry-After': '60',
          'X-Rate-Limit-Limit': '100',
          'X-Rate-Limit-Remaining': '0',
          'X-Rate-Limit-Reset': '1760000000',
          authorization: 'Bearer diagnostic-test-token',
          cookie: 'session=diagnostic-test-cookie',
          'set-cookie': 'session=diagnostic-test-cookie',
          'x-unrelated-header': 'diagnostic-test-secret',
        }),
      )
      const loggerError = vi
        .spyOn(Logger.configure('crawl'), 'error')
        .mockImplementation(() => undefined)
      const deps = makeDeps({
        createOpenApiClient: vi.fn().mockResolvedValue({
          client: {
            getTweetApi: () => ({
              getHomeTimeline: vi.fn().mockResolvedValue({ data: { data: [tweet] } }),
              getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
              getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
              getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
            }),
            getUserApi: () => ({
              getUserByRestId: vi.fn().mockRejectedValue(error),
              getUserByScreenName: vi.fn().mockResolvedValue({ data: rawUser('viewer1', 'v') }),
              getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
            }),
            getUserListApi: () => ({
              getFollowing: vi.fn().mockResolvedValue({ data: [], nextCursor: undefined }),
              getFollowers: vi.fn().mockResolvedValue({ data: [], nextCursor: undefined }),
            }),
          },
        }),
      })

      try {
        await runCrawlCycle(deps)

        expect(deps.recordCrawlAccountRun).toHaveBeenCalledWith(
          expect.objectContaining({
            status: 'partial',
            warnings: expect.arrayContaining([
              {
                type: 'author_processing_failed',
                message: expect.stringContaining(`httpStatus=${String(status)}`),
                authorId: 'author1',
                errorMessage: 'Response returned an error code',
                httpStatus: status,
                retryAfterSeconds: 60,
                rateLimitLimit: 100,
                rateLimitRemaining: 0,
                rateLimitReset: 1_760_000_000,
                appVersion: expect.any(String),
              },
            ]),
          }),
        )
        expect(deps.finishCrawlRun).toHaveBeenCalledWith('run1', expect.any(Date), 'partial')
        const [message] = loggerError.mock.calls[0] ?? []
        expect(message).toContain(`httpStatus=${String(status)}`)
        expect(message).not.toContain('diagnostic-test')
        expect(loggerError).toHaveBeenCalledWith(
          message,
          expect.objectContaining({ name: 'ResponseError', message: 'ResponseError' }),
        )
      } finally {
        loggerError.mockRestore()
      }
    },
  )

  it('treats a 404 ResponseError as an expected unavailable account', async () => {
    const author = rawUser('author1')
    const tweet = rawTweet('tweet1', author)
    const deps = makeDeps({
      createOpenApiClient: vi.fn().mockResolvedValue({
        client: {
          getTweetApi: () => ({
            getHomeTimeline: vi.fn().mockResolvedValue({ data: { data: [tweet] } }),
            getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserApi: () => ({
            getUserByRestId: vi.fn().mockRejectedValue(responseError(404)),
            getUserByScreenName: vi.fn().mockResolvedValue({ data: rawUser('viewer1', 'v') }),
            getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserListApi: () => ({
            getFollowing: vi.fn().mockResolvedValue({ data: [], nextCursor: undefined }),
            getFollowers: vi.fn().mockResolvedValue({ data: [], nextCursor: undefined }),
          }),
        },
      }),
    })

    await runCrawlCycle(deps)

    expect(deps.recordCrawlAccountRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success', warnings: [] }),
    )
    expect(deps.finishCrawlRun).toHaveBeenCalledWith('run1', expect.any(Date), 'success')
  })

  it('records a structured following_timeline_failed warning when the following timeline fetch fails', async () => {
    const deps = makeDeps({
      createOpenApiClient: vi.fn().mockResolvedValue({
        client: {
          getTweetApi: () => ({
            getHomeTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getHomeLatestTimeline: vi.fn().mockRejectedValue(new Error('following rate limited')),
            getSearchTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserApi: () => ({
            getUserByRestId: vi.fn().mockResolvedValue({ data: rawUser('author1') }),
            getUserByScreenName: vi.fn().mockResolvedValue({ data: rawUser('viewer1', 'v') }),
            getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserListApi: () => ({
            getFollowing: vi.fn().mockResolvedValue({ data: [], nextCursor: undefined }),
            getFollowers: vi.fn().mockResolvedValue({ data: [], nextCursor: undefined }),
          }),
        },
      }),
    })

    await runCrawlCycle(deps)

    expect(deps.recordCrawlAccountRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'partial',
        warnings: expect.arrayContaining([
          expect.objectContaining({
            type: 'following_timeline_failed',
            username: 'v',
            errorMessage: 'following rate limited',
          }),
        ]),
      }),
    )
  })

  it('records a structured trending_timeline_failed warning when the trending timeline fetch fails', async () => {
    const deps = makeDeps({
      createTrendsScraper: vi
        .fn()
        .mockResolvedValue({ scraper: { getTrends: vi.fn().mockResolvedValue(['trend1']) } }),
      createOpenApiClient: vi.fn().mockResolvedValue({
        client: {
          getTweetApi: () => ({
            getHomeTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getHomeLatestTimeline: vi.fn().mockResolvedValue({ data: { data: [] } }),
            getSearchTimeline: vi.fn().mockRejectedValue(new Error('trending rate limited')),
            getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserApi: () => ({
            getUserByRestId: vi.fn().mockResolvedValue({ data: rawUser('author1') }),
            getUserByScreenName: vi.fn().mockResolvedValue({ data: rawUser('viewer1', 'v') }),
            getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
          }),
          getUserListApi: () => ({
            getFollowing: vi.fn().mockResolvedValue({ data: [], nextCursor: undefined }),
            getFollowers: vi.fn().mockResolvedValue({ data: [], nextCursor: undefined }),
          }),
        },
      }),
    })

    await runCrawlCycle(deps)

    expect(deps.recordCrawlAccountRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'partial',
        warnings: expect.arrayContaining([
          expect.objectContaining({
            type: 'trending_timeline_failed',
            username: 'v',
            errorMessage: 'trending rate limited',
          }),
        ]),
      }),
    )
  })

  it('records a failed CrawlAccountRun and still proceeds to the next account when issueCookies rejects', async () => {
    const deps = makeDeps({
      config: {
        accounts: [
          { email: 'a@example.com', username: 'first', password: 'p', otpSecret: null },
          { email: 'b@example.com', username: 'second', password: 'p', otpSecret: null },
        ],
      },
      issueCookies: vi
        .fn()
        .mockImplementationOnce(() => Promise.reject(new Error('cookie issuer down')))
        .mockImplementationOnce(() => Promise.resolve({ ct0: 'c0', authToken: 'a0' })),
    })

    await runCrawlCycle(deps)

    expect(deps.recordCrawlAccountRun).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'first',
        status: 'failed',
        errorMessage: expect.stringContaining('cookie issuer down'),
      }),
    )
    expect(deps.recordCrawlAccountRun).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'second', status: 'success' }),
    )
    expect(deps.finishCrawlRun).toHaveBeenCalledWith('run1', expect.any(Date), 'failed')
  })
})
