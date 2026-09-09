import { describe, expect, it } from 'vitest'
import { ALL_LABEL_RULES } from '../all-rules'
import type { AccountFeatureBundle, LabelRule } from '../types'

function getRule(): LabelRule {
  const rule = ALL_LABEL_RULES.find((candidate) => candidate.key === 'contextual_reply_marketing')
  if (!rule) throw new Error('contextual_reply_marketing is not registered')
  return rule
}

// 本番で観測された低頻度アーキタイプ (直近19投稿, 外部リプライ6・オリジナル13) を、
// 特定の話題語にはハードコードせず複数話題にまたがる自己ポジショニングの反復として再現する。
const SELF_POSITIONING_REPLY_TEXTS = [
  '在宅ワークを始めたばかりの頃は本当に大変でしたよね。自分も最初はペース配分が全然分からなくて苦労しました。少しずつ慣れていくものだと思います。',
  '引っ越し準備、本当にお疲れさまです。フリーランスとして働く自分からすると、生活拠点を整える大切さはよく分かります。無理せず進めてくださいね。',
  '資格の勉強、根気がいりますよね。会社員から独立した自分の立場では、学び直しの大変さは身に染みて分かります。応援しています。',
  '初めての一人暮らし、緊張しますよね。地方から出てきた自分も、最初の数ヶ月は環境に慣れるだけで精一杯でした。少しずつ楽になっていきますよ。',
  '犬のしつけ、根気強く向き合っていて素敵です。ペットを飼い始めたばかりの自分としても、毎日の積み重ねの大切さを実感しています。',
  '転職活動、大変な時期ですね。何度か転職を経験した自分からすると、焦らず自分に合う環境を探すのが一番だと思います。',
]

const PLAIN_EMPATHY_REPLY_TEXTS = [
  '在宅ワークを始めたばかりの頃は本当に大変ですよね。少しずつ慣れていくものだと思いますので、無理せず頑張ってください。',
  '引っ越し準備、本当にお疲れさまです。新しい生活が落ち着くまで大変だと思いますが、応援しています。',
  '資格の勉強、根気がいりますよね。コツコツ続けているのがすごいと思います。応援しています。',
  '初めての一人暮らし、緊張しますよね。少しずつ環境に慣れていくと思うので、無理せず過ごしてくださいね。',
  '犬のしつけ、根気強く向き合っていて素敵です。毎日の積み重ねが大切だと思います。応援しています。',
  '転職活動、大変な時期ですね。焦らず自分に合う環境が見つかるといいですね。応援しています。',
]

function makeBundle(
  options: {
    replyTexts?: string[]
    originalCount?: number
    sampleSize?: number
    lifetimePerDay?: number
    intervalMinutes?: number
    verifiedType?: string | null
    professionalType?: string | null
    resolvedReplyCount?: number
    originalTextFactory?: (index: number) => string
  } = {},
): AccountFeatureBundle {
  const replyTexts = options.replyTexts ?? SELF_POSITIONING_REPLY_TEXTS
  const replyCount = replyTexts.length
  const originalTextFactory =
    options.originalTextFactory ??
    ((index: number) => `今日の出来事メモその${index}。特に変わったことはなかった一日でした。`)
  const sampleSize = options.sampleSize ?? replyCount + (options.originalCount ?? 13)
  const lifetimePerDay = options.lifetimePerDay ?? 3.4
  const intervalMinutes = options.intervalMinutes ?? 655
  const resolvedReplyCount = options.resolvedReplyCount ?? replyCount
  const now = Date.now()
  const ageDays = 200

  return {
    account: {
      id: 'acct-1',
      screenName: 'sample',
      displayName: 'Sample',
      bio: null,
      followersCount: 300,
      followingCount: 200,
      tweetCount: Math.round(lifetimePerDay * ageDays),
      accountCreatedAt: new Date(now - ageDays * 24 * 60 * 60 * 1000),
      isBlueVerified: false,
      verifiedType: options.verifiedType ?? null,
      professionalType: options.professionalType ?? null,
    },
    recentTweets: Array.from({ length: sampleSize }, (_, index) => {
      const isReply = index < replyCount
      const hasResolvedParent = isReply && index < resolvedReplyCount
      return {
        id: `tweet-${index}`,
        fullText: isReply ? replyTexts[index] : originalTextFactory(index),
        createdAt: new Date(now - index * intervalMinutes * 60 * 1000),
        retweetCount: 0,
        likeCount: 0,
        isReply,
        isRetweet: false,
        isPromoted: false,
        isPaidPromotion: false,
        inReplyToTweetId: isReply ? `parent-${index}` : null,
        parentTweetFullText: isReply ? `parent text ${index}` : null,
        parentTweetAuthorId: hasResolvedParent ? `parent-author-${index}` : null,
      }
    }),
  }
}

describe('contextualReplyMarketingRule', () => {
  it('is registered', () => {
    expect(getRule()).toBeDefined()
  })

  it('detects the low-frequency contextual-reply archetype with repeated self-positioning', () => {
    const result = getRule().evaluate(makeBundle())

    expect(result.value).toBe(true)
    expect(result.evaluable).not.toBe(false)
  })

  it('does not label normal empathetic replies without repeated self-positioning', () => {
    const result = getRule().evaluate(makeBundle({ replyTexts: PLAIN_EMPATHY_REPLY_TEXTS }))

    expect(result.value).toBe(false)
  })

  it('does not label replies with self-positioning below the minimum occurrence count', () => {
    // 外部リプライ数(4)は MIN_EXTERNAL_REPLIES を満たすが、
    // 自己ポジショニングを含むのは2件のみ (MIN_SELF_POSITIONING_COUNT=3 未満) にする。
    const result = getRule().evaluate(
      makeBundle({
        replyTexts: [
          SELF_POSITIONING_REPLY_TEXTS[0],
          SELF_POSITIONING_REPLY_TEXTS[1],
          PLAIN_EMPATHY_REPLY_TEXTS[2],
          PLAIN_EMPATHY_REPLY_TEXTS[3],
        ],
        originalCount: 15,
      }),
    )

    expect(result.value).toBe(false)
  })

  it('does not label question-driven dialogue even with self-positioning phrasing', () => {
    const result = getRule().evaluate(
      makeBundle({
        replyTexts: SELF_POSITIONING_REPLY_TEXTS.map((text) => `${text}どう思いますか？`),
      }),
    )

    expect(result.value).toBe(false)
  })

  it('does not label a creator who only posts original content without external replies', () => {
    const result = getRule().evaluate(
      makeBundle({
        replyTexts: [],
        originalCount: 19,
        originalTextFactory: (index) =>
          `新作の紹介です。詳しくはこちら https://example.com/works/${index}`,
      }),
    )

    expect(result.value).toBe(false)
  })

  it('does not label high-frequency posting even with the same self-positioning phrasing', () => {
    const result = getRule().evaluate(makeBundle({ lifetimePerDay: 60, intervalMinutes: 5 }))

    expect(result.value).toBe(false)
  })

  it('does not label verified business accounts', () => {
    const result = getRule().evaluate(makeBundle({ verifiedType: 'Business' }))

    expect(result.value).toBe(false)
  })

  it('is neutral when the recent sample is too small', () => {
    const result = getRule().evaluate(makeBundle({ sampleSize: 10, originalCount: 4 }))

    expect(result).toMatchObject({ value: false, evaluable: false, confidence: 0.5 })
  })

  it('is neutral when reply parents could not be resolved', () => {
    const result = getRule().evaluate(makeBundle({ resolvedReplyCount: 1 }))

    expect(result).toMatchObject({ value: false, evaluable: false, confidence: 0.5 })
  })
})
