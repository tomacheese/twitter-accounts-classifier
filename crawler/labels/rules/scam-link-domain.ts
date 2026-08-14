import { toConfidence } from '../confidence'
import { classifyScamDomainUrl } from '../scam-domain-url'
import type { LabelRule } from '../types'

export const scamLinkDomainRule: LabelRule = {
  key: 'scam_link_domain',
  description: '最近の投稿に、管理対象の詐欺悪用ドメインリストと一致するリンクが含まれている',
  version: '1.0.1',
  evaluate(bundle) {
    for (const tweet of bundle.recentTweets) {
      if (tweet.isRetweet) continue

      for (const url of tweet.expandedUrls ?? []) {
        const evidence = classifyScamDomainUrl(url)
        if (!evidence) continue

        return {
          value: true,
          confidence: toConfidence(true, 1),
          reason: `tweet=${tweet.id}, host=${evidence.host}, sourceRisk=${evidence.indicator.sourceReportedRisk}`,
        }
      }
    }

    return {
      value: false,
      confidence: toConfidence(false, 0),
      reason: 'no scam link domain evidence',
    }
  },
}
