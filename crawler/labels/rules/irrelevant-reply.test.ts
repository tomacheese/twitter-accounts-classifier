import { describe, expect, it } from 'vitest'
import { irrelevantReplyRule } from './irrelevant-reply'
import type { AccountFeatureBundle } from '../types'

function makeBundle(
  replies: { fullText: string; parentTweetFullText: string | null }[],
  recentTweetsFetchStatus: string | null = 'success',
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
      recentTweetsFetchStatus,
    },
    recentTweets: replies.map((r, i) => ({
      id: `t${i}`,
      fullText: r.fullText,
      createdAt: new Date(),
      retweetCount: 0,
      likeCount: 0,
      isReply: true,
      isRetweet: false,
      isPromoted: false,
      isPaidPromotion: false,
      inReplyToTweetId: `parent${i}`,
      parentTweetFullText: r.parentTweetFullText,
    })),
  }
}

describe('irrelevantReplyRule', () => {
  it('is true when most replies are topically unrelated to their parent tweet', () => {
    const bundle = makeBundle([
      { fullText: '今日から始めるダイエット法をチェックしてね', parentTweetFullText: '今日の試合は本当に感動する展開だった' },
      { fullText: 'このアイテムがセール中でお得ですよ', parentTweetFullText: '新しいアニメの最終回、泣いた' },
      { fullText: '副業に興味ある人はこちらをチェック', parentTweetFullText: '今日の天気は快晴で気持ちがいい' },
      { fullText: 'このサプリメントおすすめです', parentTweetFullText: '猫がベランダで日向ぼっこしてる' },
      { fullText: 'このコースで稼ぐ方法を紹介しています', parentTweetFullText: '新曲のMVがついに公開された' },
      { fullText: 'このツールで効率化できます', parentTweetFullText: '週末は久しぶりに旅行に行ってきた' },
    ])
    const result = irrelevantReplyRule.evaluate(bundle)
    expect(result.value).toBe(true)
  })

  it('is false when replies are topically related to their parent tweet', () => {
    const bundle = makeBundle([
      { fullText: '本当にその試合は感動しましたね、延長戦まで目が離せなかった', parentTweetFullText: '今日の試合は本当に感動する展開だった' },
      { fullText: 'あのアニメの最終回は自分も泣きました、作画も綺麗でしたね', parentTweetFullText: '新しいアニメの最終回、泣いた' },
      { fullText: 'こちらも快晴で気持ちいい天気です、洗濯物がよく乾きます', parentTweetFullText: '今日の天気は快晴で気持ちがいい' },
      { fullText: 'うちの猫も日向ぼっこ大好きです、可愛いですよね', parentTweetFullText: '猫がベランダで日向ぼっこしてる' },
      { fullText: 'このMV映像がとても綺麗で何度も見てしまいます', parentTweetFullText: '新曲のMVがついに公開された' },
      { fullText: '旅行いいですね、どこに行かれたんですか', parentTweetFullText: '週末は久しぶりに旅行に行ってきた' },
    ])
    const result = irrelevantReplyRule.evaluate(bundle)
    expect(result.value).toBe(false)
  })

  it('is evaluable=false when there are too few reply-with-parent samples', () => {
    const bundle = makeBundle([
      { fullText: '今日から始めるダイエット法をチェックしてね', parentTweetFullText: '今日の試合は本当に感動する展開だった' },
    ])
    const result = irrelevantReplyRule.evaluate(bundle)
    expect(result.evaluable).toBe(false)
  })

  it('is evaluable=false when recentTweets was never fetched', () => {
    const bundle = makeBundle(
      [
        { fullText: '今日から始めるダイエット法をチェックしてね', parentTweetFullText: '今日の試合は本当に感動する展開だった' },
      ],
      null,
    )
    const result = irrelevantReplyRule.evaluate(bundle)
    expect(result.evaluable).toBe(false)
  })
})
