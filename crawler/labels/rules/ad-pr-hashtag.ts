import { toConfidence } from '../confidence'
import type { LabelRule } from '../types'
import { isRecentTweetsEvaluable } from '../recent-tweets-evaluable'
import { hasPrDisclosure } from '../pr-disclosure'

// isPaidPromotion は X 公式の有償パートナーシップ開示機能によるフラグであり、
// ヒューリスティックな #PR ハッシュタグ検出と異なりサンプル数で信頼度を割り引く理由がない。
// そのため 1 件でも true があれば陽性とみなす。

export const adPrHashtagRule: LabelRule = {
  key: 'ad_pr_hashtag',
  description:
    '日本の Twitter で慣習的に使われる「#PR」ハッシュタグ、または X 公式の有償パートナーシップ開示機能のいずれかで、広告ツイートであることを適切に開示している',
  version: '1.5.0',
  evaluate(bundle) {
    // このラベルはアカウント自身の投稿における開示を主張するものであるため、
    // リツイート(他者が書いた本文に `RT @...` を付与したもの)は対象から除外する。
    // 除外しない場合、他者の「#PR」付き投稿をリツイートしただけで、
    // リツイートしたアカウント自身が開示していると誤判定されてしまう。
    const sampled = bundle.recentTweets.filter((t) => !t.isRetweet)
    const hasPrHashtag = sampled.some((t) => hasPrDisclosure(t.fullText))
    const hasPaidPromotionDisclosure = sampled.some((t) => t.isPaidPromotion)

    const value = hasPrHashtag || hasPaidPromotionDisclosure
    const evidenceScore = Math.min(
      (hasPrHashtag ? 0.6 : 0) + (hasPaidPromotionDisclosure ? 0.6 : 0),
      1,
    )

    // recentTweets が未取得の場合、単に開示表記が見つからないだけの陰性とは区別する。
    // value が true の場合は実際に開示表記の証拠が見つかっているため、
    // 直近の取得試行が失敗扱いでも evaluable を無条件で true にする。
    const evaluable = value || (sampled.length > 0 && isRecentTweetsEvaluable(bundle))
    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      reason: `prHashtag=${hasPrHashtag}, paidPromotionDisclosure=${hasPaidPromotionDisclosure} (n=${sampled.length})`,
      evaluable,
    }
  },
}
