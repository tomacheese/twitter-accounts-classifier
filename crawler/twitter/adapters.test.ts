import { describe, expect, it, vi } from 'vitest'
import type {
  TweetApiUtils,
  TweetApiUtilsData,
  TwitterApiUtilsResponse,
  UserApiUtils,
  UserApiUtilsData,
} from 'twitter-openapi-typescript'
import { createTweetApiLike, toRawUserResult } from './timeline'
import { createUserApiLike } from './profile'

type RealUser = TweetApiUtilsData['user']
type RealTweet = TweetApiUtilsData['tweet']

function makeRealUser(
  overrides: Partial<RealUser['legacy']> = {},
  verifiedType?: string,
): RealUser {
  return {
    typename: 'User',
    id: 'u1',
    restId: 'u1',
    isBlueVerified: false,
    profileImageShape: 'Circle',
    legacy: {
      screenName: 'someone',
      name: 'Someone',
      description: 'bio',
      followersCount: 10,
      friendsCount: 5,
      statusesCount: 100,
      createdAt: 'Wed Jan 01 00:00:00 +0000 2020',
      ...overrides,
    },
    verification: verifiedType ? { verified: true, verifiedType } : undefined,
  } as RealUser
}

function makeRealTweet(overrides: Partial<TweetApiUtilsData> = {}): TweetApiUtilsData {
  return {
    raw: {} as never,
    replies: [],
    tweet: {
      restId: 't1',
      legacy: {
        fullText: 'hello',
        createdAt: 'Wed Jan 01 00:00:00 +0000 2020',
        retweetCount: 0,
        favoriteCount: 0,
        replyCount: 0,
        quoteCount: 0,
      },
    } as RealTweet,
    user: makeRealUser(),
    ...overrides,
  }
}

function makeTimelineResponse(
  data: TweetApiUtilsData[],
): Promise<
  TwitterApiUtilsResponse<{ data: TweetApiUtilsData[]; cursor: { bottom?: { value: string } } }>
> {
  return Promise.resolve({ raw: {} as never, header: {} as never, data: { data, cursor: {} } })
}

describe('toRawUserResult', () => {
  it('derives verifiedType from user.verification?.verifiedType', () => {
    const verified = toRawUserResult(makeRealUser({}, 'Business'))
    expect(verified.verifiedType).toBe('Business')

    const unverified = toRawUserResult(makeRealUser())
    expect(unverified.verifiedType).toBeNull()
  })
})

describe('createTweetApiLike (real-shape adapter)', () => {
  it('drops a tombstoned entry (no legacy) instead of crashing', async () => {
    const tombstoned = makeRealTweet({ tweet: { restId: 't-tombstoned' } as RealTweet })
    const getHomeTimeline = vi
      .fn()
      .mockReturnValue(makeTimelineResponse([tombstoned, makeRealTweet()]))
    const tweetApi: TweetApiUtils = { getHomeTimeline } as unknown as TweetApiUtils

    const adapter = createTweetApiLike(tweetApi)
    const result = await adapter.getHomeTimeline({ count: 20 })

    expect(result.data.data).toHaveLength(1)
    expect(result.data.data[0].restId).toBe('t1')
  })

  it('derives retweetedStatusIdStr from the retweeted entry, not a flat legacy field', async () => {
    const retweetOriginal = makeRealTweet({
      tweet: {
        restId: 'original1',
        legacy: { ...makeRealTweet().tweet.legacy, fullText: 'original' },
      } as RealTweet,
    })
    const retweetEntry = makeRealTweet({
      tweet: {
        restId: 't-retweet',
        legacy: { ...makeRealTweet().tweet.legacy, fullText: 'RT @x: original' },
      } as RealTweet,
      retweeted: retweetOriginal,
    })
    const getHomeTimeline = vi.fn().mockReturnValue(makeTimelineResponse([retweetEntry]))
    const tweetApi: TweetApiUtils = { getHomeTimeline } as unknown as TweetApiUtils

    const adapter = createTweetApiLike(tweetApi)
    const result = await adapter.getHomeTimeline({ count: 20 })

    expect(result.data.data[0].legacy.retweetedStatusIdStr).toBe('original1')
  })

  it('preserves source-user metadata on directly attached video media', async () => {
    const sourceAttributedVideo = makeRealTweet({
      tweet: {
        restId: 't-source-attributed',
        legacy: {
          ...makeRealTweet().tweet.legacy,
          extendedEntities: {
            media: [{ type: 'video', sourceUserIdStr: 'source-author' }],
          },
        },
      } as RealTweet,
    })
    const getHomeTimeline = vi.fn().mockReturnValue(makeTimelineResponse([sourceAttributedVideo]))
    const tweetApi: TweetApiUtils = { getHomeTimeline } as unknown as TweetApiUtils

    const adapter = createTweetApiLike(tweetApi)
    const result = await adapter.getHomeTimeline({ count: 20 })

    expect(result.data.data[0].legacy.extendedEntities?.media).toEqual([
      { type: 'video', sourceUserIdStr: 'source-author' },
    ])
  })
})

describe('createUserApiLike (real-shape adapter)', () => {
  it('throws when the user lookup returns no user (suspended/deleted account)', async () => {
    const getUserByRestId = vi.fn().mockResolvedValue({
      raw: {} as never,
      header: {} as never,
      data: { raw: {} as never, user: undefined } as UserApiUtilsData,
    } as TwitterApiUtilsResponse<UserApiUtilsData>)
    const userApi: UserApiUtils = { getUserByRestId } as unknown as UserApiUtils
    const tweetApi: TweetApiUtils = {} as unknown as TweetApiUtils

    const adapter = createUserApiLike(userApi, tweetApi)

    await expect(adapter.getUserByRestId({ userId: 'u1' })).rejects.toThrow('User not found')
  })
})
