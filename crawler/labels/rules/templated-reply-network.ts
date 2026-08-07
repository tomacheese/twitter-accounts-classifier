import type { LabelRule } from '../types'

// チャットボット駆動のリプライネットワークは、
// テンプレート化されたリプライを大量生成する。このルールが捉えるのは、
// `bot` ルール(投稿頻度・返信比率)や `ad_reply_hijack` ルール(広告・暗号資産の勧誘語)が見逃す信号、
// すなわちリプライ本文自体が内容と無関係に複数の別アカウント間で一字一句共有されている点を捉える。
const MIN_NETWORK_SIZE = 5

export const templatedReplyNetworkRule: LabelRule = {
  key: 'templated_reply_network',
  description:
    '投稿したリプライの文面(URL/メンションを除去した上で比較)が、他の複数の別アカウントと一字一句同一である。定型文を大量生成するリプライボットネットワークの特徴',
  version: '1.1.0',
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
