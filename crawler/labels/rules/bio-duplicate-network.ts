import { rampScore, toConfidence } from '../confidence'
import type { LabelRule } from '../types'

// bio の複製ネットワークは、templated_reply_network と同水準の閾値を採用する。
const MIN_NETWORK_SIZE = 5

export const bioDuplicateNetworkRule: LabelRule = {
  key: 'bio_duplicate_network',
  description:
    'プロフィール bio(URL/メンションを除去した上で比較)が、他の複数の別アカウントと一字一句同一である。' +
    '複製した bio を使い回す fake persona ネットワークの特徴',
  version: '1.0.0',
  evaluate(bundle) {
    const networkSize = bundle.bioDuplicateNetworkSize ?? 0
    const value = networkSize >= MIN_NETWORK_SIZE
    const evidenceScore = rampScore(
      networkSize,
      MIN_NETWORK_SIZE,
      MIN_NETWORK_SIZE,
      'higher-is-positive',
    )
    return {
      value,
      confidence: toConfidence(value, evidenceScore),
      reason: `bioDuplicateNetworkSize=${networkSize}`,
    }
  },
}
