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

  it('is false for a bio that declines dating/investment/adult-content DM solicitation using "受け付けません", even with a mass-following pattern', () => {
    const result = spamRule.evaluate(
      makeBundle({
        bio: '出会い系・投資・アダルト系のDMは受け付けません。趣味の話がしたいです。',
        followersCount: 10,
        followingCount: 800,
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

  it('is true for mass-following combined with a bait-like retweet ratio even without a solicitation bio', () => {
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
      makeBundle({ bio: '日常アカウントです', followersCount: 10, followingCount: 800 }, tweets),
    )
    expect(result.value).toBe(true)
  })

  it('is false for mass-following alone (no bait retweet ratio) without a solicitation bio', () => {
    const result = spamRule.evaluate(
      makeBundle({ bio: '日常アカウントです', followersCount: 10, followingCount: 800 }),
    )
    expect(result.value).toBe(false)
  })

  it('is false for a bait-like retweet ratio alone (no mass-following) without a solicitation bio', () => {
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
      makeBundle({ bio: '日常アカウントです', followersCount: 500, followingCount: 400 }, tweets),
    )
    expect(result.value).toBe(false)
  })

  it('gives a higher confidence to a stronger reinforcing signal among value=true cases', () => {
    const weak = spamRule.evaluate(
      makeBundle({ bio: '副業紹介します', followersCount: 100, followingCount: 500 }),
    )
    const strong = spamRule.evaluate(
      makeBundle({ bio: '副業紹介します', followersCount: 50, followingCount: 1000 }),
    )
    expect(weak.value).toBe(true)
    expect(strong.value).toBe(true)
    expect(strong.confidence).toBeGreaterThan(weak.confidence)
  })

  it('is true when tweet-body solicitation phrases repeat across multiple recent tweets, even without bio solicitation', () => {
    const bundle: AccountFeatureBundle = {
      account: {
        id: '1',
        screenName: 'x',
        displayName: 'X',
        bio: 'よろしくお願いします',
        followersCount: 50,
        followingCount: 600,
        tweetCount: 10,
        accountCreatedAt: new Date(),
        isBlueVerified: false,
        verifiedType: null,
      },
      recentTweets: [
        {
          id: 't1',
          fullText: '副業紹介してます、稼げる情報あります',
          createdAt: new Date(),
          retweetCount: 0,
          likeCount: 0,
          isReply: false,
          isRetweet: false,
          isPromoted: false,
          isPaidPromotion: false,
        },
        {
          id: 't2',
          fullText: '今日も副業募集中!稼げるチャンスです',
          createdAt: new Date(),
          retweetCount: 0,
          likeCount: 0,
          isReply: false,
          isRetweet: false,
          isPromoted: false,
          isPaidPromotion: false,
        },
      ],
    }
    const result = spamRule.evaluate(bundle)
    expect(result.value).toBe(true)
  })

  it('is false when only a single tweet contains a solicitation phrase', () => {
    const bundle: AccountFeatureBundle = {
      account: {
        id: '1',
        screenName: 'x',
        displayName: 'X',
        bio: null,
        followersCount: 50,
        followingCount: 600,
        tweetCount: 10,
        accountCreatedAt: new Date(),
        isBlueVerified: false,
        verifiedType: null,
      },
      recentTweets: [
        {
          id: 't1',
          fullText: '副業紹介してます、稼げる情報あります',
          createdAt: new Date(),
          retweetCount: 0,
          likeCount: 0,
          isReply: false,
          isRetweet: false,
          isPromoted: false,
          isPaidPromotion: false,
        },
      ],
    }
    const result = spamRule.evaluate(bundle)
    expect(result.value).toBe(false)
  })

  it('does not count a solicitation-like tweet that is itself a rejection', () => {
    const bundle: AccountFeatureBundle = {
      account: {
        id: '1',
        screenName: 'x',
        displayName: 'X',
        bio: null,
        followersCount: 50,
        followingCount: 600,
        tweetCount: 10,
        accountCreatedAt: new Date(),
        isBlueVerified: false,
        verifiedType: null,
      },
      recentTweets: [
        {
          id: 't1',
          fullText: '副業の勧誘はお断りしています',
          createdAt: new Date(),
          retweetCount: 0,
          likeCount: 0,
          isReply: false,
          isRetweet: false,
          isPromoted: false,
          isPaidPromotion: false,
        },
        {
          id: 't2',
          fullText: '副業のDMはお断りです、ご遠慮ください',
          createdAt: new Date(),
          retweetCount: 0,
          likeCount: 0,
          isReply: false,
          isRetweet: false,
          isPromoted: false,
          isPaidPromotion: false,
        },
      ],
    }
    const result = spamRule.evaluate(bundle)
    expect(result.value).toBe(false)
  })

  it('is false when the only tweet-body solicitation phrases appear in retweeted (not own) tweets', () => {
    const bundle: AccountFeatureBundle = {
      account: {
        id: '1',
        screenName: 'x',
        displayName: 'X',
        bio: null,
        followersCount: 500,
        followingCount: 600,
        tweetCount: 10,
        accountCreatedAt: new Date(),
        isBlueVerified: false,
        verifiedType: null,
      },
      recentTweets: Array.from({ length: 5 }, (_, i) => ({
        id: `t${i}`,
        fullText:
          i < 2 ? '副業紹介してます、稼げる情報あります' : `RT @someone: おすすめの一冊その${i}`,
        createdAt: new Date(),
        retweetCount: 0,
        likeCount: 0,
        isReply: false,
        isRetweet: true,
        isPromoted: false,
        isPaidPromotion: false,
      })),
    }
    const result = spamRule.evaluate(bundle)
    expect(result.value).toBe(false)
  })

  it('boosts confidence when low-effort signup signals accompany a positive spam judgment', () => {
    const withoutSignals = spamRule.evaluate(
      makeBundle({
        bio: 'dm me for some fun ! 出会い活してます',
        followersCount: 10,
        followingCount: 800,
      }),
    )
    const withSignals = spamRule.evaluate(
      makeBundle({
        bio: 'dm me for some fun ! 出会い活してます',
        followersCount: 10,
        followingCount: 800,
        screenName: 'user12345678',
        profileImageUrl:
          'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png',
      }),
    )
    expect(withoutSignals.value).toBe(true)
    expect(withSignals.value).toBe(true)
    expect(withSignals.confidence).toBeGreaterThanOrEqual(withoutSignals.confidence)
  })

  it('does not change confidence for a value=false account regardless of low-effort signup signals', () => {
    const withoutSignals = spamRule.evaluate(
      makeBundle({
        bio: null,
        followersCount: 10,
        followingCount: 800,
      }),
    )
    const withSignals = spamRule.evaluate(
      makeBundle({
        bio: null,
        followersCount: 10,
        followingCount: 800,
        screenName: 'user12345678',
        profileImageUrl:
          'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png',
      }),
    )
    expect(withoutSignals.value).toBe(false)
    expect(withSignals.value).toBe(false)
    expect(withSignals.confidence).toBe(withoutSignals.confidence)
  })
})
