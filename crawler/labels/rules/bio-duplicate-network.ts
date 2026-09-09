import { rampScore, toConfidence } from '../confidence'
import type { LabelRule } from '../types'

// bio の複製ネットワークは、templated_reply_network と同水準の閾値を採用する。
const MIN_NETWORK_SIZE = 5

export const bioDuplicateNetworkRule: LabelRule = {
  key: 'bio_duplicate_network',
  description:
    'プロフィール bio(URL/メンションを除去した上で比較)が、他の複数の別アカウントと一字一句同一である。' +
    '複製した bio を使い回す偽装アカウントネットワークの特徴',
  version: '1.1.0',
  evaluate(bundle) {
    const networkSize = bundle.bioDuplicateNetworkSize ?? 0
    const value = networkSize >= MIN_NETWORK_SIZE
    const evidenceScore = rampScore(
      networkSize,
      MIN_NETWORK_SIZE,
      MIN_NETWORK_SIZE,
      'higher-is-positive',
    )
    // bio が無いアカウントは複製比較そのものができないため、
    // 「一致が無かった」のではなく判定材料が無いだけである。
    // templated-reply-network.ts の recentTweets 未取得時の扱いと同じ考え方で、
    // value が true の場合は実際に一致の証拠が見つかっているため無条件で evaluable にする。
    const evaluable = value || bundle.account.bio !== null
    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      reason: `bioDuplicateNetworkSize=${networkSize}`,
      evaluable,
    }
  },
}
