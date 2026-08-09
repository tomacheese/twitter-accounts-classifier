import { classifyAmazonAffiliateUrl } from '../amazon-affiliate-url'
import type { LabelRule } from '../types'

export const amazonAffiliateLinkRule: LabelRule = {
  key: 'amazon_affiliate_link',
  description:
    '自身の最近の投稿に、Amazonアソシエイト由来と高い確度で判断できるリンクが含まれている',
  version: '1.0.0',
  evaluate(bundle) {
    for (const tweet of bundle.recentTweets) {
      if (tweet.isRetweet) continue

      for (const url of tweet.expandedUrls ?? []) {
        const evidence = classifyAmazonAffiliateUrl(url)
        if (!evidence) continue

        return {
          value: true,
          confidence: evidence.kind === 'associate-tag' ? 1 : 0.9,
          reason: `tweet=${tweet.id}, evidence=${evidence.kind}, host=${evidence.host}`,
        }
      }
    }

    return { value: false, confidence: 0, reason: 'no Amazon affiliate link evidence' }
  },
}
