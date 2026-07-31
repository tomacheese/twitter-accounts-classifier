import type { LabelRule } from '../types'

// Chatbot-driven reply networks auto-generate templated replies at scale. This targets a
// signal the `bot` rule (posting frequency/reply ratio) and `ad_reply_hijack` rule (ad/crypto
// pitch keywords) both miss: the reply text itself is shared verbatim across several distinct
// accounts, regardless of what it says.
const MIN_NETWORK_SIZE = 5

export const templatedReplyNetworkRule: LabelRule = {
  key: 'templated_reply_network',
  description:
    '投稿したリプライの文面(URL/メンションを除去した上で比較)が、他の複数の別アカウントと一字一句同一である。定型文を大量生成するリプライボットネットワークの特徴',
  version: '1.0.0',
  evaluate(bundle) {
    const networkSize = bundle.templatedReplyNetworkSize ?? 0
    const value = networkSize >= MIN_NETWORK_SIZE
    return {
      value,
      confidence: value ? Math.min(1, networkSize / 20) : 0,
      reason: `templatedReplyNetworkSize=${networkSize}`,
    }
  },
}
