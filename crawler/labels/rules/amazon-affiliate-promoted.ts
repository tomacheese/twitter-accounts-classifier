import { classifyAmazonAffiliateUrl } from '../amazon-affiliate-url'
import type { LabelRule } from '../types'

const PR_DISCLOSURE_PATTERN = /(?:#PR(?![\p{L}\p{N}_])|[【（([]\s*PR\s*[】）)\]])/iu

export const amazonAffiliatePromotedRule: LabelRule = {
  key: 'amazon_affiliate_promoted',
  description:
    '自身の最近の投稿のうち、Amazonアソシエイトリンクを含む同一投稿がX上でプロモートされている',
  version: '1.0.0',
  evaluate(bundle) {
    for (const tweet of bundle.recentTweets) {
      if (tweet.isRetweet || !tweet.isPromoted) continue

      for (const url of tweet.expandedUrls ?? []) {
        const evidence = classifyAmazonAffiliateUrl(url)
        if (!evidence) continue

        const prDisclosure = PR_DISCLOSURE_PATTERN.test(tweet.fullText)
        return {
          value: true,
          confidence: evidence.kind === 'associate-tag' ? 1 : 0.95,
          reason: `tweet=${tweet.id}, evidence=${evidence.kind}, host=${evidence.host}, paidPromotion=${tweet.isPaidPromotion}, prDisclosure=${prDisclosure}`,
        }
      }
    }

    return {
      value: false,
      confidence: 0,
      reason: 'no promoted original tweet with Amazon affiliate link evidence',
    }
  },
}
