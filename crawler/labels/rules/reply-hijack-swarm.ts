import type { LabelRule } from '../types'

const MIN_DISTINCT_AUTHORS = 5
// reply-hijack-index.ts の `SIMILARITY_THRESHOLD` を引き上げるだけでは、協調的な
// インプレッション稼ぎと、バズったツイートへの純粋な大量反応を分離できない。
// お悔やみや結婚祝いのような定型的な礼儀リプライは、farming の実例よりも高い類似度を
// 示すことがあり、定型的な決まり文句は farming であっても心のこもったものであっても
// 同程度「似ている」と判定されてしまうためである。そのためスウォームへの参加は
// 必要条件にとどめ、アカウント自身の直近の活動が低努力・リプライ主体であることも
// 併せて要求する。心のこもったお祝いリプライを送る人物は、通常オリジナル投稿が
// 一切ないアカウントではないため。
const MIN_SAMPLE = 3
// アカウント自身の投稿は文字通り返信でなければならない。「オリジナルでない」だけでは
// 不十分で、`originalContentRatio` はリツイートもオリジナルでないとみなすため、
// 通常のリツイート消費型の人間(他者を転載するのが大半で、稀に返信する程度)も
// このガードを素通りしてしまう。真のリプライハイジャック・スウォームは
// 返信に特化したアーキタイプである。
const REPLY_RATIO_THRESHOLD = 0.5

/**
 * 「一斉提灯リプライ」スウォームに参加したアカウントを検出する。5アカウント以上が、
 * 同一の高エンゲージメントツイートに対して言い回しの似た低努力リプライをそれぞれ
 * 短時間のうちに投稿し、他者のバズ投稿からインプレッションを稼ぐ挙動を指す。
 * スウォームへの参加は `AccountFeatureBundle.replyHijackSwarmSize` によって判定され、
 * これはクロール・再ラベリングごとにルール単位ではなく共有コーパスから一括計算される。
 * ただし参加のみでは十分ではなく(上記 `REPLY_RATIO_THRESHOLD` を参照)、
 * アカウント自身の直近の投稿も返信主体・低努力であることを要求する。異なる投稿者間の
 * テキスト類似度だけでは、協調的な farming と、同一ツイートへの純粋な大量反応
 * (お悔やみや祝福など)を区別できないため。
 */
export const replyHijackSwarmRule: LabelRule = {
  key: 'reply_hijack_swarm',
  description:
    '別々のアカウントが1件ずつ、似た言い回しの低努力リプライを1つの高エンゲージメントツイートに乗せてインプレッションを稼ぐ「一斉提灯リプライ」ネットワークの一員であり、かつ自身のアカウントもオリジナル投稿がほぼない低努力アカウントである',
  version: '1.3.0',
  evaluate(bundle) {
    const size = bundle.replyHijackSwarmSize ?? 0
    const isSwarmMember = size >= MIN_DISTINCT_AUTHORS

    const sampled = bundle.recentTweets
    const hasEnoughSample = sampled.length >= MIN_SAMPLE
    const replyRatio =
      sampled.length > 0 ? sampled.filter((t) => t.isReply).length / sampled.length : 0
    const looksReplyFocused = hasEnoughSample && replyRatio >= REPLY_RATIO_THRESHOLD

    const value = isSwarmMember && looksReplyFocused
    const confidence = value ? Math.min(1, size / 15) : 0

    return {
      value,
      confidence,
      reason: `replyHijackSwarmSize=${size}, replyRatio=${replyRatio.toFixed(2)} (n=${sampled.length})`,
    }
  },
}
