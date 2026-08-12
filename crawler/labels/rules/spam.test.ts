import { describe, expect, it } from 'vitest'
import { spamRule } from './spam'
import type { AccountFeatureBundle } from '../types'

function makeBundle(
  accountOverrides: Partial<AccountFeatureBundle['account']>,
  recentTweets: AccountFeatureBundle['recentTweets'] = [],
): AccountFeatureBundle {
  return {
    account: {
      id: '1',
      screenName: 'x',
      displayName: 'X',
      bio: null,
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date(),
      isBlueVerified: false,
      verifiedType: null,
      ...accountOverrides,
    },
    recentTweets,
  }
}

describe('spamRule', () => {
  it('is true for a dating-solicitation bio with a mass-following pattern', () => {
    const result = spamRule.evaluate(
      makeBundle({
        bio: 'dm me for some fun ! 出会い活してます',
        followersCount: 10,
        followingCount: 800,
      }),
    )
    expect(result.value).toBe(true)
    expect(result.confidence).toBeGreaterThan(0)
  })

  it('is true for a declared-automation solicitation bio with a bait-like retweet ratio', () => {
    const tweets: AccountFeatureBundle['recentTweets'] = Array.from({ length: 5 }, (_, i) => ({
      id: `t${i}`,
      fullText: 'RT @someone: ...',
      createdAt: new Date(),
      retweetCount: 0,
      likeCount: 0,
      isReply: false,
      isRetweet: true,
      isPromoted: false,
      isPaidPromotion: false,
    }))
    const result = spamRule.evaluate(
      makeBundle(
        {
          bio: '自動フォローで繋がりましょう！稼げる情報も発信',
          followersCount: 500,
          followingCount: 400,
        },
        tweets,
      ),
    )
    expect(result.value).toBe(true)
  })

  it('is false when the bio has no solicitation language', () => {
    const result = spamRule.evaluate(
      makeBundle({
        bio: 'Developer. Posting about tech and everyday life.',
        followersCount: 100,
        followingCount: 50,
      }),
    )
    expect(result.value).toBe(false)
  })

  it('is false for ordinary follow-courtesy wording ("フォロバ", "相互フォロー"), even with a mass-following pattern', () => {
    const result = spamRule.evaluate(
      makeBundle({
        bio: '相互フォロー大歓迎！フォロバします。無言フォローご自由に。DMください。',
        followersCount: 10,
        followingCount: 800,
      }),
    )
    expect(result.value).toBe(false)
  })

  it('is false when solicitation language is absent even with a mass-following pattern', () => {
    const result = spamRule.evaluate(
      makeBundle({ bio: 'Just here to read the news', followersCount: 10, followingCount: 800 }),
    )
    expect(result.value).toBe(false)
  })

  it('is false for a bio that declines dating-solicitation follows ("出会い系...お断り"), even with a mass-following pattern', () => {
    const result = spamRule.evaluate(
      makeBundle({
        bio: '投資や副業、アルバイト勧誘、出会い系といったフォローはお断りです。',
        followersCount: 10,
        followingCount: 800,
      }),
    )
    expect(result.value).toBe(false)
  })

  it('is false for a bio that declines dating-solicitation follows using "御断り", even with a mass-following pattern', () => {
    const result = spamRule.evaluate(
      makeBundle({
        bio: '宣伝目的、出会い系は固く御断りします',
        followersCount: 10,
        followingCount: 800,
      }),
    )
    expect(result.value).toBe(false)
  })

  it('is false for a bio that refuses side-hustle solicitation with prohibition symbols right after "副業"', () => {
    const result = spamRule.evaluate(
      makeBundle({
        bio: '副業🆖❌趣味のお友達募集中！仲良くしてください！',
        followersCount: 10,
        followingCount: 800,
      }),
    )
    expect(result.value).toBe(false)
  })

  it('is false for a bio that turns down dating-app solicitation in casual plain form', () => {
    const result = spamRule.evaluate(
      makeBundle({
        bio: 'のんびり暮らしてます。出会い系のフォロー要らんよ😅 好きなものは読書と散歩とラジオ',
        followersCount: 100,
        followingCount: 2000,
      }),
    )
    expect(result.value).toBe(false)
  })

  it('is true for a bio with an early rejected dating-solicitation mention followed by a separate, unrejected side-hustle solicitation', () => {
    const result = spamRule.evaluate(
      makeBundle({
        bio: '出会い系はお断りです。副業で稼げる情報も紹介しています',
        followersCount: 10,
        followingCount: 800,
      }),
    )
    expect(result.value).toBe(true)
  })

  it('is false for a bio that lists multiple rejected solicitation types before a single trailing rejection word', () => {
    const result = spamRule.evaluate(
      makeBundle({
        bio: '出会い系、投資、副業、高額バイトなどの怪しいアカウントからのフォローは全てブロックします',
        followersCount: 10,
        followingCount: 800,
      }),
    )
    expect(result.value).toBe(false)
  })

  it('is false for a bio that declines solicitation using casual slang ("スルー")', () => {
    const result = spamRule.evaluate(
      makeBundle({
        bio: '写真とカフェ巡りが好きな雑談アカウント。出会い系目的のフォローはスルーしています。',
        followersCount: 10,
        followingCount: 800,
      }),
    )
    expect(result.value).toBe(false)
  })

  it('is false for a bio that declines solicitation using a half-width katakana rejection word', () => {
    const result = spamRule.evaluate(
      makeBundle({
        bio: '出会い系、副業系、その他勧誘系ﾀﾞﾒｰ',
        followersCount: 10,
        followingCount: 800,
      }),
    )
    expect(result.value).toBe(false)
  })

  it('is false for a bio that declines solicitation using "拒否"', () => {
    const result = spamRule.evaluate(
      makeBundle({
        bio: '副業紹介やDMでの勧誘は拒否します。写真と旅行が好きな平日休みの会社員です。',
        followersCount: 10,
        followingCount: 800,
      }),
    )
    expect(result.value).toBe(false)
  })

  it('is false for a low-following, high-follower official/celebrity-shaped account even with courtesy wording', () => {
    const result = spamRule.evaluate(
      makeBundle({
        bio: 'お仕事依頼は気軽にDMください。フォロバは基本しません。',
        followersCount: 50_000,
        followingCount: 2,
      }),
    )
    expect(result.value).toBe(false)
  })
})
