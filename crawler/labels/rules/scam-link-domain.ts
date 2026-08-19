import { toConfidence } from '../confidence'
import { isRecentTweetsEvaluable } from '../recent-tweets-evaluable'
import { classifyScamDomainUrl } from '../scam-domain-url'
import type { LabelRule } from '../types'

export const scamLinkDomainRule: LabelRule = {
  key: 'scam_link_domain',
  description: '最近の投稿に、管理対象の詐欺悪用ドメインリストと一致するリンクが含まれている',
  version: '1.1.0',
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

    // recentTweets が未取得の場合、単に一致が無いだけの陰性とは区別する。
    // 未取得のまま高確信度の false を返すと、取得漏れが偏って存在するリスクを検出できなくなるため。
    const evaluable = isRecentTweetsEvaluable(bundle)
    return {
      value: false,
      confidence: toConfidence(false, 0, evaluable),
      reason: 'no scam link domain evidence',
      evaluable,
    }
  },
}
