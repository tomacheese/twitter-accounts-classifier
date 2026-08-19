import { classifyAmazonAffiliateUrl } from '../amazon-affiliate-url'
import { toConfidence } from '../confidence'
import { isRecentTweetsEvaluable } from '../recent-tweets-evaluable'
import type { LabelRule } from '../types'

const PR_DISCLOSURE_PATTERN = /(?:#PR(?![\p{L}\p{N}_])|[【（([]\s*PR\s*[】）)\]])/iu

export const amazonAffiliatePromotedRule: LabelRule = {
  key: 'amazon_affiliate_promoted',
  description:
    '自身の最近の投稿のうち、Amazonアソシエイトリンクを含む同一投稿がX上でプロモートされている',
  version: '1.1.0',
  evaluate(bundle) {
    for (const tweet of bundle.recentTweets) {
      if (tweet.isRetweet || !tweet.isPromoted) continue

      for (const url of tweet.expandedUrls ?? []) {
        const evidence = classifyAmazonAffiliateUrl(url)
        if (!evidence) continue

        const prDisclosure = PR_DISCLOSURE_PATTERN.test(tweet.fullText)
        const evidenceScore = evidence.kind === 'associate-tag' ? 1 : 0.95
        return {
          value: true,
          confidence: toConfidence(true, evidenceScore),
          reason: `tweet=${tweet.id}, evidence=${evidence.kind}, host=${evidence.host}, paidPromotion=${tweet.isPaidPromotion}, prDisclosure=${prDisclosure}`,
        }
      }
    }

    // recentTweets が未取得の場合、単に一致が無いだけの陰性とは区別する。
    // 未取得のまま高確信度の false を返すと、取得漏れが偏って存在するリスクを検出できなくなるため。
    const evaluable = isRecentTweetsEvaluable(bundle)
    return {
      value: false,
      confidence: toConfidence(false, 0, evaluable),
      reason: 'no promoted original tweet with Amazon affiliate link evidence',
      evaluable,
    }
  },
}
