import { expect, it } from 'vitest'
import type { Account, Tweet } from '../generated/prisma'
import { buildBioDuplicateIndex } from './bio-duplicate-index'
import { buildAccountFeatureBundle } from './build-account-feature-bundle'
import { buildDuplicateReplyIndex } from './duplicate-reply-index'
import { buildReplyHijackIndex } from './reply-hijack-index'
import { buildSelfReplyPromoIndex } from './self-reply-promo-index'

it('parent tweet author id is exposed for reply classification', () => {
  const account = {
    id: 'acct-1',
    screenName: 'a',
    displayName: 'A',
    bio: null,
    followersCount: 0,
    followingCount: 0,
    tweetCount: 1,
    accountCreatedAt: new Date('2026-01-01T00:00:00Z'),
    isBlueVerified: false,
    verifiedType: null,
  } as Account
  const tweet = {
    id: 'reply-1',
    accountId: 'acct-1',
    fullText: 'reply',
    createdAt: new Date('2026-08-29T00:00:00Z'),
    retweetCount: 0,
    likeCount: 0,
    isReply: true,
    isRetweet: false,
    isPromoted: false,
    isPaidPromotion: false,
    inReplyToTweetId: 'parent-1',
  } as Tweet
  const bundle = buildAccountFeatureBundle(
    account,
    [tweet],
    buildDuplicateReplyIndex([]),
    buildBioDuplicateIndex([]),
    buildReplyHijackIndex([]),
    { signalsFor: () => ({}) },
    buildSelfReplyPromoIndex([], []),
    new Map([['parent-1', 'parent text']]),
    new Map([['parent-1', 'other-account']]),
  )

  expect(bundle.recentTweets[0].parentTweetAuthorId).toBe('other-account')
})
