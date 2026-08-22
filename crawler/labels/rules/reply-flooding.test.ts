import { describe, expect, it } from 'vitest'
import { replyFloodingRule } from './reply-flooding'
import type { AccountFeatureBundle } from '../types'

function makeBundle(
  tweets: {
    fullText: string
    isReply?: boolean
    isRetweet?: boolean
    minutesAgo?: number
    inReplyToTweetId?: string | null
  }[],
  accountOverrides: Partial<AccountFeatureBundle['account']> = {},
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
    recentTweets: tweets.map((t, i) => ({
      id: `t${i}`,
      fullText: t.fullText,
      createdAt: new Date(Date.now() - (t.minutesAgo ?? 0) * 60_000),
      retweetCount: 0,
      likeCount: 0,
      isReply: t.isReply ?? false,
      isRetweet: t.isRetweet ?? false,
      inReplyToTweetId: t.inReplyToTweetId === undefined ? 'target1' : t.inReplyToTweetId,
      isPromoted: false,
      isPaidPromotion: false,
    })),
  }
}

describe('replyFloodingRule', () => {
  it('is true for many paraphrased replies flooding a single target within a short window', () => {
    const bundle = makeBundle(
      [
        'この動画おもしろすぎて何回も見ちゃった 😂',
        '何回見てもこの動画おもしろすぎる 😂',
        'この動画ほんとにおもしろい、笑いが止まらない 💀',
        'こんなにおもしろい動画は久しぶりに見た 😭',
        'おもしろすぎて友達にもこの動画を送っちゃった 😂',
        'この動画、何回も見てるけどやっぱりおもしろい 👀',
        'こんな動画は見たことない、おもしろすぎる 💀',
        'この動画のおもしろさは何回見ても変わらない 😭',
        '笑いが止まらないくらいおもしろい動画だった 😂',
        '何回も見返すくらいおもしろい動画でした 👀',
      ].map((text, i) => ({
        fullText: `@example_target ${text}`,
        isReply: true,
        minutesAgo: i * 5,
      })),
    )

    const result = replyFloodingRule.evaluate(bundle)

    expect(result.value).toBe(true)
    expect(result.confidence).toBeGreaterThan(0)
  })

  it('is false for a genuine extended chat where each reply is topically unrelated', () => {
    const bundle = makeBundle(
      [
        'ごめん、さっき通知に気づかなかった',
        '駅前の新しいカフェ行ってみたよ',
        '明日の予定どうする？',
        'そのアニメ全部見たわ',
        '雨すごいね、傘持ってる？',
        'バイト終わったら連絡するね',
        'ケーキ焼いたら失敗した',
        '来週のライブ楽しみすぎる',
      ].map((text, i) => ({
        fullText: `@target ${text}`,
        isReply: true,
        minutesAgo: i * 3,
      })),
    )

    const result = replyFloodingRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it('is false for a back-and-forth conversation answering a different tweet each time', () => {
    const bundle = makeBundle(
      Array.from({ length: 12 }, (_, i) => ({
        fullText: `@friend そうそう、それでね、こういう感じだったんだよ ${i}`,
        isReply: true,
        minutesAgo: i * 4,
        inReplyToTweetId: `their-tweet-${i}`,
      })),
    )

    const result = replyFloodingRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it('is false when replies to the same person have no known parent tweet', () => {
    const bundle = makeBundle(
      Array.from({ length: 10 }, (_, i) => ({
        fullText: `@target 全く同じ内容の返信です全く同じ内容の返信です ${i}`,
        isReply: true,
        minutesAgo: i,
        inReplyToTweetId: null,
      })),
    )

    const result = replyFloodingRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it('is false when reply count to any single target is below the minimum sample size', () => {
    const bundle = makeBundle(
      Array.from({ length: 5 }, (_, i) => ({
        fullText: `@target 全く同じ内容の返信です全く同じ内容の返信です ${i}`,
        isReply: true,
        minutesAgo: i,
      })),
    )

    const result = replyFloodingRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it('is false when the same volume of similar replies is spread across many days', () => {
    const bundle = makeBundle(
      Array.from({ length: 10 }, (_, i) => ({
        fullText: `@target 全く同じ内容の返信です全く同じ内容の返信です ${i}`,
        isReply: true,
        minutesAgo: i * 60 * 24 * 3,
      })),
    )

    const result = replyFloodingRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it('ignores retweets when grouping replies by target', () => {
    const bundle = makeBundle(
      Array.from({ length: 10 }, (_, i) => ({
        fullText: `RT @target 全く同じ内容の返信です全く同じ内容の返信です ${i}`,
        isReply: false,
        isRetweet: true,
        minutesAgo: i,
      })),
    )

    const result = replyFloodingRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it('does not treat otherwise distinct live commentary as flooding solely because of a shared hashtag', () => {
    const commentary = [
      'ゴール！これは熱い #日本代表',
      '惜しい！あと少しだった #日本代表',
      '前半終了、0-0 #日本代表',
      '選手交代きた #日本代表',
      'ナイスセーブ！ #日本代表',
      '後半開始、いけるぞ #日本代表',
      'PK獲得！ #日本代表',
      '試合終了、お疲れさま #日本代表',
    ]
    const result = replyFloodingRule.evaluate(
      makeBundle(
        commentary.map((fullText, index) => ({
          fullText: `@target ${fullText}`,
          isReply: true,
          minutesAgo: index,
        })),
      ),
    )

    expect(result.value).toBe(false)
  })

  it('is false for live-commentary replies that only share a running-gag phrase and hashtag, not actual content', () => {
    const bundle = makeBundle(
      [
        'このシーンで泣いた #実況中 見てて',
        'まさかの展開すぎる #実況中 見てて',
        'ここで笑うとは思わなかった #実況中 見てて',
        '次の場面が気になる #実況中 見てて',
        'このセリフ好き #実況中 見てて',
        '音楽が良すぎる #実況中 見てて',
        'このキャラ推せる #実況中 見てて',
        '展開が読めない #実況中 見てて',
        '演技がうまい #実況中 見てて',
      ].map((text, i) => ({
        fullText: `@example_target ${text}`,
        isReply: true,
        minutesAgo: i * 5,
      })),
    )
    const result = replyFloodingRule.evaluate(bundle)
    expect(result.value).toBe(false)
  })

  it('is false with neutral evaluable=false when recentTweets were never fetched, instead of a confident false', () => {
    const result = replyFloodingRule.evaluate(makeBundle([], { recentTweetsFetchStatus: null }))
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBe(0.5)
  })

  it('keeps a confident false when recentTweets were fetched successfully but no flooding target exists', () => {
    const result = replyFloodingRule.evaluate(
      makeBundle([], { recentTweetsFetchStatus: 'success' }),
    )
    expect(result.value).toBe(false)
    expect(result.evaluable ?? true).toBe(true)
    expect(result.confidence).toBe(1)
  })
})
