import { describe, expect, it } from 'vitest'
import { adReplyHijackRule } from './ad-reply-hijack'
import type { AccountFeatureBundle } from '../types'

function makeBundle(recentTweets: AccountFeatureBundle['recentTweets']): AccountFeatureBundle {
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
    },
    recentTweets,
  }
}

function replyTweet(i: number, isAdPitch: boolean): AccountFeatureBundle['recentTweets'][number] {
  return {
    id: `t${i}`,
    fullText: isAdPitch
      ? `@someone 今の職場に満足していますか？転職エージェントに無料相談してみませんか #転職 ${i}`
      : `@someone 同感です ${i}`,
    createdAt: new Date(),
    retweetCount: 0,
    likeCount: 0,
    isReply: true,
    isRetweet: false,
    isPromoted: false,
    isPaidPromotion: false,
  }
}

function giveawayReplyTweet(i: number): AccountFeatureBundle['recentTweets'][number] {
  return {
    id: `g${i}`,
    fullText: `@someone Congrats on the milestone! We're doing a giveaway, connect wallet and claim now #airdrop ${i}`,
    createdAt: new Date(),
    retweetCount: 0,
    likeCount: 0,
    isReply: true,
    isRetweet: false,
    isPromoted: false,
    isPaidPromotion: false,
  }
}

function entryReplyTweet(i: number): AccountFeatureBundle['recentTweets'][number] {
  return {
    id: `e${i}`,
    fullText: `応募しました！このプレゼント企画当たりますように #${i}`,
    createdAt: new Date(),
    retweetCount: 0,
    likeCount: 0,
    isReply: true,
    isRetweet: false,
    isPromoted: false,
    isPaidPromotion: false,
    parentTweetFullText: `フォロー&リポストでプレゼント企画実施中！ #${i}`,
  }
}

describe('adReplyHijackRule', () => {
  it("is true when most of an account's replies are ad/job-change pitches", () => {
    const tweets = [
      replyTweet(1, true),
      replyTweet(2, true),
      replyTweet(3, true),
      replyTweet(4, false),
    ]
    const result = adReplyHijackRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(true)
    expect(result.confidence).toBeGreaterThan(0)
  })

  it('is false when replies rarely contain ad/job-change language', () => {
    const tweets = [
      replyTweet(1, false),
      replyTweet(2, false),
      replyTweet(3, false),
      replyTweet(4, true),
    ]
    const result = adReplyHijackRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(false)
  })

  it('is false when there are too few replies to judge (below the minimum sample size)', () => {
    const tweets = [replyTweet(1, true), replyTweet(2, true)]
    const result = adReplyHijackRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(false)
  })

  it("is true when most of an account's replies are crypto giveaway/airdrop pitches", () => {
    const tweets = [
      giveawayReplyTweet(1),
      giveawayReplyTweet(2),
      giveawayReplyTweet(3),
      replyTweet(4, false),
    ]
    const result = adReplyHijackRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(true)
    expect(result.confidence).toBeGreaterThan(0)
  })

  it('is false for benign replies with no ad, job-change, or giveaway/airdrop language', () => {
    const tweets = [
      replyTweet(1, false),
      replyTweet(2, false),
      replyTweet(3, false),
      replyTweet(4, false),
    ]
    const result = adReplyHijackRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(false)
  })

  it('is not evaluable when the reply sample is below the minimum', () => {
    const result = adReplyHijackRule.evaluate(makeBundle([]))
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBeCloseTo(0.5)
  })

  it('is false for a self-promotional numbered thread replying to its own preceding tweets, not hijacking others', () => {
    const ownTweet: AccountFeatureBundle['recentTweets'][number] = {
      id: 'own0',
      fullText: '転職エージェントのサービス比較シリーズ、はじめます🧵',
      createdAt: new Date(),
      retweetCount: 0,
      likeCount: 0,
      isReply: false,
      isRetweet: false,
      isPromoted: false,
      isPaidPromotion: false,
    }
    const selfThreadReplies = [1, 2, 3, 4].map((i) => ({
      id: `self${i}`,
      fullText: `続き${i}: 転職エージェントに無料相談してみませんか #転職`,
      createdAt: new Date(),
      retweetCount: 0,
      likeCount: 0,
      isReply: true,
      isRetweet: false,
      isPromoted: false,
      isPaidPromotion: false,
      inReplyToTweetId: i === 1 ? 'own0' : `self${i - 1}`,
    }))
    const result = adReplyHijackRule.evaluate(makeBundle([ownTweet, ...selfThreadReplies]))
    expect(result.value).toBe(false)
  })

  it('is false for a brand account replying to its own giveaway campaign applicants, who mention it', () => {
    const campaignReplyTweet = (i: number): AccountFeatureBundle['recentTweets'][number] => ({
      id: `c${i}`,
      fullText: `@applicant${i} この度のプレゼント企画は落選でした。またのご応募をお待ちしております`,
      createdAt: new Date(),
      retweetCount: 0,
      likeCount: 0,
      isReply: true,
      isRetweet: false,
      isPromoted: false,
      isPaidPromotion: false,
      parentTweetFullText: `@brand_official 応募します！このプレゼント企画当たるといいな`,
    })
    const tweets = [1, 2, 3, 4].map((i) => campaignReplyTweet(i))
    const result = adReplyHijackRule.evaluate({
      account: {
        id: '1',
        screenName: 'brand_official',
        displayName: 'Brand',
        bio: null,
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        isBlueVerified: false,
        verifiedType: null,
      },
      recentTweets: tweets,
    })
    expect(result.evaluable).toBe(false)
  })

  it('is false for a giveaway hunter entering other brands’ real campaigns, not pitching its own', () => {
    const tweets = [1, 2, 3, 4].map((i) => entryReplyTweet(i))
    const result = adReplyHijackRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(false)
  })

  it('is still true when the ad pitch targets tweets that never mention the replying account', () => {
    const tweets = [1, 2, 3, 4].map((i) => ({
      ...giveawayReplyTweet(i),
      parentTweetFullText: `バズってるね #${i}`,
    }))
    const result = adReplyHijackRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(true)
  })

  it.each([
    '応募させていただきます',
    '応募いたします',
    '応募します',
    '参加させていただきます',
    '参加します',
    '当選しましたら投稿します',
  ])('is false for a giveaway hunter using the polite entry phrasing: %s', (phrase) => {
    const tweets = [1, 2, 3, 4].map((i) => ({
      ...entryReplyTweet(i),
      fullText: `素敵なプレゼント企画をありがとうございます！${phrase} #${i}`,
    }))
    const result = adReplyHijackRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(false)
  })

  it.each(['プレゼント企画も大好物です', 'プレゼント企画が好きです', 'プレゼント企画いつも楽しみ'])(
    'is false for a viewer who only says they like giveaways: %s',
    (phrase) => {
      const tweets = Array.from({ length: 4 }, (_, i) => ({
        ...replyTweet(i, false),
        fullText: `@someone 毎回楽しく視聴しています。${phrase} ${i}`,
      }))
      expect(adReplyHijackRule.evaluate(makeBundle(tweets)).value).toBe(false)
    },
  )

  it('does not count a bare 副業 mention as an ad pitch', () => {
    const replies = Array.from({ length: 4 }, (_, i) => ({
      ...replyTweet(i, false),
      fullText: `@someone 私も副業で似たことをやっています ${i}`,
    }))

    expect(adReplyHijackRule.evaluate(makeBundle(replies)).value).toBe(false)
  })

  it('still counts 副業 when it co-occurs with another ad term', () => {
    const replies = Array.from({ length: 4 }, (_, i) => ({
      ...replyTweet(i, false),
      fullText: `@someone 副業の案件情報を無料相談で紹介しています ${i}`,
    }))

    expect(adReplyHijackRule.evaluate(makeBundle(replies)).value).toBe(true)
  })

  it('職業の自己説明としての「求人側」を含む返信は広告として数えない', () => {
    const tweets = [1, 2, 3].map((i) => ({
      ...replyTweet(i, false),
      fullText: `@someone 採用の求人側を担当しています。お気軽にどうぞ ${i}`,
    }))
    expect(adReplyHijackRule.evaluate(makeBundle(tweets)).value).toBe(false)
  })

  it('「求人情報はこちら」のような勧誘は引き続き広告として数える', () => {
    const tweets = [1, 2, 3].map((i) => ({
      ...replyTweet(i, false),
      fullText: `@someone 高収入の求人情報はこちら ${i}`,
    }))
    expect(adReplyHijackRule.evaluate(makeBundle(tweets)).value).toBe(true)
  })
})
