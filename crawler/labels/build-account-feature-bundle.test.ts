import { describe, expect, it } from 'vitest'
import type { Account, Tweet } from '../generated/prisma'
import { buildDuplicateReplyIndex } from './duplicate-reply-index'
import { buildBioDuplicateIndex } from './bio-duplicate-index'
import { buildReplyHijackIndex } from './reply-hijack-index'
import { buildAccountFeatureBundle } from './build-account-feature-bundle'
import { buildSelfReplyPromoIndex } from './self-reply-promo-index'

const emptyFollowGraphLabelIndex = { signalsFor: () => ({}) }

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acct-1',
    screenName: 'test_user',
    displayName: 'Test User',
    bio: 'test bio',
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
    firstSeenAt: new Date('2020-01-01T00:00:00Z'),
    lastCrawledAt: new Date('2026-01-01T00:00:00Z'),
    lastRecentTweetsAttemptedAt: null,
    lastRecentTweetsFetchedAt: null,
    recentTweetsFetchStatus: null,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

function makeTweet(overrides: Partial<Tweet> = {}): Tweet {
  return {
    id: 't1',
    accountId: 'acct-1',
    fullText: 'hello world',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    retweetCount: 0,
    likeCount: 0,
    replyCount: 0,
    quoteCount: 0,
    isReply: false,
    inReplyToTweetId: null,
    isAuthorReply: false,
    isRetweet: false,
    retweetedTweetId: null,
    isPromoted: false,
    isPaidPromotion: false,
    expandedUrls: [],
    hasAiGeneratedMedia: null,
    aiGeneratedDetectionSource: null,
    quotedTweetId: null,
    quotedTweetAuthorId: null,
    quotedTweetHasVideo: null,
    foreignVideoSourceCount: null,
    source: 'recommended',
    collectedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

describe('buildAccountFeatureBundle', () => {
  it('AI メディア関連フィールドを bundle に含める', () => {
    const bundle = buildAccountFeatureBundle(
      makeAccount(),
      [makeTweet({ hasAiGeneratedMedia: true, aiGeneratedDetectionSource: 'C2paClient' })],
      buildDuplicateReplyIndex([]),
      buildBioDuplicateIndex([]),
      buildReplyHijackIndex([]),
      emptyFollowGraphLabelIndex,
      buildSelfReplyPromoIndex([], []),
      new Map(),
    )

    expect(bundle.recentTweets[0].hasAiGeneratedMedia).toBe(true)
    expect(bundle.recentTweets[0].aiGeneratedDetectionSource).toBe('C2paClient')
  })

  it('account の classification-relevant フィールドをそのまま反映する', () => {
    const bundle = buildAccountFeatureBundle(
      makeAccount({ isBlueVerified: true, professionalType: 'Creator' }),
      [],
      buildDuplicateReplyIndex([]),
      buildBioDuplicateIndex([]),
      buildReplyHijackIndex([]),
      emptyFollowGraphLabelIndex,
      buildSelfReplyPromoIndex([], []),
      new Map(),
    )

    expect(bundle.account.isBlueVerified).toBe(true)
    expect(bundle.account.professionalType).toBe('Creator')
  })

  it('reply ツイートの重複ネットワーク規模を templatedReplyNetworkSize に反映する', () => {
    const duplicateReplyIndex = buildDuplicateReplyIndex([
      {
        accountId: 'other-1',
        fullText: 'おはようございます、今日も一日頑張りましょう',
        inReplyToTweetId: 'target-1',
      },
      {
        accountId: 'other-2',
        fullText: 'おはようございます、今日も一日頑張りましょう',
        inReplyToTweetId: 'target-2',
      },
    ])
    const bundle = buildAccountFeatureBundle(
      makeAccount(),
      [
        makeTweet({
          isReply: true,
          fullText: 'おはようございます、今日も一日頑張りましょう',
          inReplyToTweetId: 'target-3',
        }),
      ],
      duplicateReplyIndex,
      buildBioDuplicateIndex([]),
      buildReplyHijackIndex([]),
      emptyFollowGraphLabelIndex,
      buildSelfReplyPromoIndex([], []),
      new Map(),
    )

    expect(bundle.templatedReplyNetworkSize).toBe(2)
  })

  it('parent ツイート本文が parentTweetTextById にあれば recentTweets に反映する', () => {
    const bundle = buildAccountFeatureBundle(
      makeAccount(),
      [makeTweet({ isReply: true, inReplyToTweetId: 'parent-1' })],
      buildDuplicateReplyIndex([]),
      buildBioDuplicateIndex([]),
      buildReplyHijackIndex([]),
      emptyFollowGraphLabelIndex,
      buildSelfReplyPromoIndex([], []),
      new Map([['parent-1', 'これが親ツイートの本文です']]),
    )

    expect(bundle.recentTweets[0].parentTweetFullText).toBe('これが親ツイートの本文です')
  })

  it('parentTweetTextById に該当がなければ parentTweetFullText を null にする', () => {
    const bundle = buildAccountFeatureBundle(
      makeAccount(),
      [makeTweet({ isReply: true, inReplyToTweetId: 'unknown-parent' })],
      buildDuplicateReplyIndex([]),
      buildBioDuplicateIndex([]),
      buildReplyHijackIndex([]),
      emptyFollowGraphLabelIndex,
      buildSelfReplyPromoIndex([], []),
      new Map(),
    )

    expect(bundle.recentTweets[0].parentTweetFullText).toBeNull()
  })

  it('bio の複製ネットワーク規模を bioDuplicateNetworkSize に反映する', () => {
    const bio = '毎日投稿しています。仲良くしてください、DMは受け付けていません'
    const bioDuplicateIndex = buildBioDuplicateIndex([
      { accountId: 'other-1', bio },
      { accountId: 'other-2', bio },
    ])
    const bundle = buildAccountFeatureBundle(
      makeAccount({ bio }),
      [],
      buildDuplicateReplyIndex([]),
      bioDuplicateIndex,
      buildReplyHijackIndex([]),
      emptyFollowGraphLabelIndex,
      buildSelfReplyPromoIndex([], []),
      new Map(),
    )

    expect(bundle.bioDuplicateNetworkSize).toBe(2)
  })

  it('account.profileImageUrl をそのまま bundle に反映する', () => {
    const bundle = buildAccountFeatureBundle(
      makeAccount({ profileImageUrl: 'https://pbs.twimg.com/profile_images/example/avatar.jpg' }),
      [],
      buildDuplicateReplyIndex([]),
      buildBioDuplicateIndex([]),
      buildReplyHijackIndex([]),
      emptyFollowGraphLabelIndex,
      buildSelfReplyPromoIndex([], []),
      new Map(),
    )

    expect(bundle.account.profileImageUrl).toBe(
      'https://pbs.twimg.com/profile_images/example/avatar.jpg',
    )
  })

  it('self-reply promo chain の証拠を selfReplyPromoEvidence に反映する', () => {
    const selfReplyPromoIndex = buildSelfReplyPromoIndex(
      [
        {
          id: 'r1',
          accountId: 'acct-1',
          inReplyToTweetId: 'root1',
          fullText: 'これマジで見て',
          expandedUrls: ['https://x.com/other_creator/status/999'],
          createdAt: new Date('2026-01-01T00:00:00Z'),
          authorScreenName: 'test_user',
        },
        {
          id: 'r2',
          accountId: 'acct-1',
          inReplyToTweetId: 'root2',
          fullText: 'これマジで見て',
          expandedUrls: ['https://x.com/other_creator/status/999'],
          createdAt: new Date('2026-01-01T00:00:00Z'),
          authorScreenName: 'test_user',
        },
        {
          id: 'r3',
          accountId: 'acct-1',
          inReplyToTweetId: 'root3',
          fullText: 'これマジで見て',
          expandedUrls: ['https://x.com/other_creator/status/999'],
          createdAt: new Date('2026-01-01T00:00:00Z'),
          authorScreenName: 'test_user',
        },
      ],
      [
        { id: 'root1', accountId: 'acct-1', isReply: false, isRetweet: false },
        { id: 'root2', accountId: 'acct-1', isReply: false, isRetweet: false },
        { id: 'root3', accountId: 'acct-1', isReply: false, isRetweet: false },
      ],
    )

    const bundle = buildAccountFeatureBundle(
      makeAccount(),
      [],
      buildDuplicateReplyIndex([]),
      buildBioDuplicateIndex([]),
      buildReplyHijackIndex([]),
      emptyFollowGraphLabelIndex,
      selfReplyPromoIndex,
      new Map(),
    )

    expect(bundle.selfReplyPromoEvidence?.exactDestinationRoots).toBe(3)
  })
})
