import { rampScore, toConfidence } from '../confidence'
import type { LabelRule } from '../types'
import { isRecentTweetsEvaluable } from '../recent-tweets-evaluable'

// チャットボット駆動のリプライネットワークは、
// テンプレート化されたリプライを大量生成する。このルールが捉えるのは、
// `bot` ルール(投稿頻度・返信比率)や `ad_reply_hijack` ルール(広告・暗号資産の勧誘語)が見逃す信号、
// すなわちリプライ本文自体が内容と無関係に複数の別アカウント間で一字一句共有されている点を捉える。
const MIN_NETWORK_SIZE = 5

export const templatedReplyNetworkRule: LabelRule = {
  key: 'templated_reply_network',
  description:
    '投稿したリプライの文面(URL/メンションを除去した上で比較)が、他の複数の別アカウントと一字一句同一である。定型文を大量生成するリプライボットネットワークの特徴',
  version: '1.3.0',
  evaluate(bundle) {
    const networkSize = bundle.templatedReplyNetworkSize ?? 0
    const value = networkSize >= MIN_NETWORK_SIZE
    const evidenceScore = rampScore(
      networkSize,
      MIN_NETWORK_SIZE,
      MIN_NETWORK_SIZE,
      'higher-is-positive',
    )
    // networkSize は自身のリプライを走査して集計するため、
    // recentTweets が未取得の場合は「一致が無かった」のではなく判定材料が無いだけである。
    // value が true の場合は実際に一致の証拠が見つかっているため、
    // 直近の取得試行が失敗扱いでも evaluable を無条件で true にする。
    const evaluable = value || isRecentTweetsEvaluable(bundle)
    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      reason: `templatedReplyNetworkSize=${networkSize}`,
      evaluable,
    }
  },
}
