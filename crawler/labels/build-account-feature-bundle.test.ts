import { describe, expect, it } from 'vitest'
import type { Account, Tweet } from '../generated/prisma'
import { buildDuplicateReplyIndex } from './duplicate-reply-index'
import { buildReplyHijackIndex } from './reply-hijack-index'
import { buildAccountFeatureBundle } from './build-account-feature-bundle'

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
      buildReplyHijackIndex([]),
      emptyFollowGraphLabelIndex,
    )

    expect(bundle.recentTweets[0].hasAiGeneratedMedia).toBe(true)
    expect(bundle.recentTweets[0].aiGeneratedDetectionSource).toBe('C2paClient')
  })

  it('account の classification-relevant フィールドをそのまま反映する', () => {
    const bundle = buildAccountFeatureBundle(
      makeAccount({ isBlueVerified: true, professionalType: 'Creator' }),
      [],
      buildDuplicateReplyIndex([]),
      buildReplyHijackIndex([]),
      emptyFollowGraphLabelIndex,
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
      buildReplyHijackIndex([]),
      emptyFollowGraphLabelIndex,
    )

    expect(bundle.templatedReplyNetworkSize).toBe(2)
  })
})
