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
  displayName?: string
  bio?: string | null
  distinctParentAuthorCount?: number
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
      displayName: options.displayName ?? 'Sample',
      bio: options.bio ?? null,
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
      const parentAuthorIndex = options.distinctParentAuthorCount
        ? index % options.distinctParentAuthorCount
        : index
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
            : `parent-author-${parentAuthorIndex}`
          : null,
      }
    }),
  }
}

/**
 * 指定した interval (分) で n 件のツイート列を配置したときの recentTweetsPerDay 相当を得るための、
 * 平均間隔 (分) を逆算する。makeBundle の intervalMinutes に渡す。
 */
function intervalMinutesForRecentRate(sampleSize: number, recentTweetsPerDay: number): number {
  const spanDays = (sampleSize - 1) / recentTweetsPerDay
  return (spanDays * 24 * 60) / (sampleSize - 1)
}

const crossLanguageGenericJapaneseText =
  'そのお気持ち本当にすごくわかります。大変な状況の中で、それでも前向きに取り組んでいる姿勢が伝わってきて、' +
  'こちらまで励まされる気持ちになりました。無理せず、ご自身のペースで進めていただければと思います。'
const crossLanguageConcreteJapaneseText =
  '今回の事例では二要素認証の設定手順が異なり、旧システムとの互換性にも個別の制約があります。' +
  '導入時期によって参照すべき手順書のバージョンも変わるため、事前確認が必要です。'
const crossLanguageEnglishText =
  'Totally agree with this take, really appreciate you sharing the update with everyone here.'

describe('genericReplyFarmingRule', () => {
  it('is registered as a shadow label rule', () => {
    expect(getRule()).toBeDefined()
  })

  it('bumps the version to reflect the added low-frequency branch', () => {
    expect(getRule().version).toBe('0.2.0')
  })

  it('detects high-volume generic context-aware external replies', () => {
    const result = getRule().evaluate(makeBundle())

    expect(result.value).toBe(true)
    expect(result.evaluable).toBe(true)
  })

  it('keeps the pre-existing high-frequency confidence and branch indicator unchanged', () => {
    const result = getRule().evaluate(makeBundle())

    expect(result.confidence).toBeCloseTo(0.588_888_888_888_888_9, 10)
    expect(result.reason).toContain('matchedBranch=high-frequency')
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

  describe('low-frequency cross-language contextual reply branch', () => {
    const lowFrequencyBaseOptions = {
      sampleSize: 17,
      replyCount: 17,
      resolvedReplyCount: 17,
      lifetimePerDay: 3.8,
      intervalMinutes: intervalMinutesForRecentRate(17, 1.9),
      displayName: 'Alex Morgan',
      bio: 'Sharing thoughts on markets and life',
      textFactory: () => crossLanguageGenericJapaneseText,
    } as const

    const questionHeavyBaseOptions = {
      sampleSize: 20,
      replyCount: 20,
      resolvedReplyCount: 20,
      lifetimePerDay: 6.4,
      intervalMinutes: intervalMinutesForRecentRate(20, 0.9),
      displayName: 'Priya Shah',
      bio: 'Just here to chat with people',
      textFactory: (index: number) =>
        index % 5 === 0
          ? crossLanguageConcreteJapaneseText
          : `${crossLanguageGenericJapaneseText}？`,
    } as const

    it('detects a low-frequency cross-language candidate (English profile, Japanese replies)', () => {
      const result = getRule().evaluate(makeBundle(lowFrequencyBaseOptions))

      expect(result.value).toBe(true)
      expect(result.evaluable).toBe(true)
      expect(result.reason).toContain('matchedBranch=low-frequency-cross-language')
      expect(result.reason).toContain('distinctParentAuthors=17')
      expect(result.reason).toContain('distinctParentAuthorRatio=1.00')
      expect(result.reason).toContain('replyJapaneseRatio=1.00')
      expect(result.reason).toContain('profileHasLetters=true')
      expect(result.reason).toContain('profileHasJapanese=false')
    })

    it('detects a low-frequency cross-language candidate even with a high question ratio', () => {
      const result = getRule().evaluate(makeBundle(questionHeavyBaseOptions))

      expect(result.value).toBe(true)
    })

    it('does not label the same question-heavy fixture when the profile is Japanese', () => {
      const result = getRule().evaluate(
        makeBundle({
          ...questionHeavyBaseOptions,
          displayName: '田中太郎',
          bio: '日常のことをつぶやいています',
        }),
      )

      expect(result.value).toBe(false)
    })

    it('does not label a profile with no letters at all', () => {
      const result = getRule().evaluate(
        makeBundle({ ...lowFrequencyBaseOptions, displayName: '0000', bio: null }),
      )

      expect(result.value).toBe(false)
    })

    it('does not label a low-frequency candidate with too few distinct parent authors', () => {
      const result = getRule().evaluate(
        makeBundle({ ...questionHeavyBaseOptions, distinctParentAuthorCount: 3 }),
      )

      expect(result.value).toBe(false)
    })

    it('does not label a low-frequency candidate whose generic reaction ratio is below 0.5', () => {
      const result = getRule().evaluate(
        makeBundle({
          ...lowFrequencyBaseOptions,
          textFactory: () => crossLanguageConcreteJapaneseText,
        }),
      )

      expect(result.value).toBe(false)
    })

    it('does not label a low-frequency candidate with insufficient Japanese reply ratio', () => {
      const result = getRule().evaluate(
        makeBundle({
          ...lowFrequencyBaseOptions,
          textFactory: () => crossLanguageEnglishText,
        }),
      )

      expect(result.value).toBe(false)
    })

    it('does not label a low-frequency candidate on verified Business accounts', () => {
      const result = getRule().evaluate(
        makeBundle({ ...questionHeavyBaseOptions, verifiedType: 'Business' }),
      )

      expect(result.value).toBe(false)
    })
  })
})
