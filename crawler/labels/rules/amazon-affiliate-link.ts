import { classifyAmazonAffiliateUrl } from '../amazon-affiliate-url'
import { toConfidence } from '../confidence'
import { isRecentTweetsEvaluable } from '../recent-tweets-evaluable'
import type { LabelRule } from '../types'

export const amazonAffiliateLinkRule: LabelRule = {
  key: 'amazon_affiliate_link',
  description:
    '自身の最近の投稿に、Amazonアソシエイト由来と高い確度で判断できるリンクが含まれている',
  version: '1.1.0',
  evaluate(bundle) {
    for (const tweet of bundle.recentTweets) {
      if (tweet.isRetweet) continue

      for (const url of tweet.expandedUrls ?? []) {
        const evidence = classifyAmazonAffiliateUrl(url)
        if (!evidence) continue

        const evidenceScore = evidence.kind === 'associate-tag' ? 1 : 0.9
        return {
          value: true,
          confidence: toConfidence(true, evidenceScore),
          reason: `tweet=${tweet.id}, evidence=${evidence.kind}, host=${evidence.host}`,
        }
      }
    }

    // recentTweets が未取得の場合、単に一致が無いだけの陰性とは区別する。
    const evaluable = isRecentTweetsEvaluable(bundle)
    return {
      value: false,
      confidence: toConfidence(false, 0, evaluable),
      reason: 'no Amazon affiliate link evidence',
      evaluable,
    }
  },
}
