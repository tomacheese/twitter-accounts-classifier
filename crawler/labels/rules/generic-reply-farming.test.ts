import { describe, expect, it } from 'vitest'
import { ALL_LABEL_RULES } from '../all-rules'
import type { AccountFeatureBundle, LabelRule } from '../types'

function getRule(): LabelRule {
  const rule = ALL_LABEL_RULES.find((candidate) => candidate.key === 'generic_reply_farming')
  if (!rule) throw new Error('generic_reply_farming is not registered')
  return rule
}

interface BundleOptions {
  sampleSize?: number
  replyCount?: number
  lifetimePerDay?: number
  intervalMinutes?: number
  verifiedType?: string | null
  resolvedReplyCount?: number
  parentMode?: 'external' | 'self'
  textFactory?: (index: number) => string
}

function makeBundle(options: BundleOptions = {}): AccountFeatureBundle {
  const sampleSize = options.sampleSize ?? 20
  const replyCount = options.replyCount ?? sampleSize
  const lifetimePerDay = options.lifetimePerDay ?? 60
  const intervalMinutes = options.intervalMinutes ?? 15
  const resolvedReplyCount = options.resolvedReplyCount ?? replyCount
  const now = Date.now()
  const ageDays = 100
  const genericText =
    'そういう時こそ冷静に考えたいですね。本当に大変な状況ですが、無理をしすぎず適度な距離感も大事だと思います。'
  const textFactory = options.textFactory ?? (() => genericText)

  return {
    account: {
      id: 'acct-1',
      screenName: 'sample',
      displayName: 'Sample',
      bio: null,
      followersCount: 100,
      followingCount: 100,
      tweetCount: Math.round(lifetimePerDay * ageDays),
      accountCreatedAt: new Date(now - ageDays * 24 * 60 * 60 * 1000),
      isBlueVerified: false,
      verifiedType: options.verifiedType ?? null,
    },
    recentTweets: Array.from({ length: sampleSize }, (_, index) => {
      const isReply = index < replyCount
      const hasResolvedParent = isReply && index < resolvedReplyCount
      return {
        id: `tweet-${index}`,
        fullText: isReply ? textFactory(index) : `original post ${index}`,
        createdAt: new Date(now - index * intervalMinutes * 60 * 1000),
        retweetCount: 0,
        likeCount: 0,
        isReply,
        isRetweet: false,
        isPromoted: false,
        isPaidPromotion: false,
        inReplyToTweetId: isReply ? `parent-${index}` : null,
        parentTweetFullText: isReply ? `parent text ${index}` : null,
        parentTweetAuthorId: hasResolvedParent
          ? options.parentMode === 'self'
            ? 'acct-1'
            : `parent-author-${index}`
          : null,
      }
    }),
  }
}

describe('genericReplyFarmingRule', () => {
  it('is registered as a shadow label rule', () => {
    expect(getRule()).toBeDefined()
  })

  it('detects high-volume generic context-aware external replies', () => {
    const result = getRule().evaluate(makeBundle())

    expect(result.value).toBe(true)
    expect(result.evaluable).toBe(true)
  })

  it('detects an account-level repeated abstract closing even without generic empathy phrases', () => {
    const result = getRule().evaluate(
      makeBundle({
        textFactory: (index) =>
          `話題${index}の背景が昔から現在までどのように変化してきたのか流れがつながっているみたい。過去の出来事も想像しながら、この先もまた追いたい`,
      }),
    )

    expect(result.value).toBe(true)
  })

  it('does not label verified Business support-style accounts', () => {
    const result = getRule().evaluate(makeBundle({ verifiedType: 'Business' }))

    expect(result.value).toBe(false)
  })

  it('does not label high-volume short greeting replies', () => {
    const result = getRule().evaluate(makeBundle({ textFactory: () => 'こんにちは〜✨✨' }))

    expect(result.value).toBe(false)
  })

  it('does not label replies that consistently add concrete information', () => {
    const result = getRule().evaluate(
      makeBundle({
        textFactory: (index) =>
          `事例${index}では二要素認証にQRコード読み取りが必要で、支店統廃合後の運用手順にも具体的な制約があります。`,
      }),
    )

    expect(result.value).toBe(false)
  })

  it('does not label discussion-heavy replies with frequent concrete questions', () => {
    const result = getRule().evaluate(
      makeBundle({
        textFactory: (index) =>
          `この事例${index}では前提条件が違いますが、どの資料を参照していますか？具体的な根拠はありますか？`,
      }),
    )

    expect(result.value).toBe(false)
  })

  it('does not count high-volume self replies as external farming', () => {
    const result = getRule().evaluate(makeBundle({ parentMode: 'self' }))

    expect(result.value).toBe(false)
  })

  it('accepts the observed 60 percent reply-ratio boundary when other evidence is strong', () => {
    const result = getRule().evaluate(makeBundle({ replyCount: 12 }))

    expect(result.value).toBe(true)
  })

  it('does not label low-lifetime-volume accounts even during a short reply burst', () => {
    const result = getRule().evaluate(makeBundle({ lifetimePerDay: 10 }))

    expect(result.value).toBe(false)
  })

  it('is neutral when a reply-heavy sample lacks enough resolved parent authors', () => {
    const result = getRule().evaluate(makeBundle({ resolvedReplyCount: 8 }))

    expect(result).toMatchObject({ value: false, evaluable: false, confidence: 0.5 })
  })

  it('is neutral when the recent sample is too small', () => {
    const result = getRule().evaluate(makeBundle({ sampleSize: 8, replyCount: 8 }))

    expect(result).toMatchObject({ value: false, evaluable: false, confidence: 0.5 })
  })
  it('detects high-volume casual generic reactions without polite-form markers', () => {
    const result = getRule().evaluate(
      makeBundle({
        textFactory: (index) =>
          `話題${index}、こういう展開になるとはほんと予想外だったね。見ている側もめっちゃ気持ちが揺れる場面だね。最後まで見られてよかった。`,
      }),
    )

    expect(result.value).toBe(true)
  })

  it('detects a repeated account-level suffix without a phrase-specific closing regex', () => {
    const result = getRule().evaluate(
      makeBundle({
        textFactory: (index) =>
          `話題${index}では複数の出来事が時間をおいて結び付いていて、前後の経緯を整理しながら、関連する展開をもっと知りたい`,
      }),
    )

    expect(result.value).toBe(true)
  })
})
