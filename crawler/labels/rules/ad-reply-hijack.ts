import type { LabelRule } from '../types'

// 転職勧誘・広告案件系の語だけでなく暗号資産のギブアウェイ/エアドロップ勧誘も含めているのは、
// 高エンゲージメントツイートに偽ギブアウェイやエアドロップのリプライを大量投稿するボットネットワークが、
// 転職勧誘単体よりも支配的なリプライハイジャックの手口であるため。
// 英単語は他のトピック系ルールと同様に単語境界でマッチさせ、
// 無関係な単語の内部にはマッチしないようにしている。
const AD_JOB_PITCH_PATTERN =
  /転職(エージェント|活動|相談|しませんか|しよう)|求人|副業|案件情報|PR案件|広告案件|アフィリ|セミナー情報|無料相談|エアドロ(ップ)?|無料配布|プレゼント企画|\bgiveaway\b|\bairdrop\b|\bclaim\s*now\b|\bconnect\s*wallet\b|\bfree\s*mint\b/i

const MIN_REPLY_SAMPLE = 3
const AD_REPLY_RATIO_THRESHOLD = 0.5

export const adReplyHijackRule: LabelRule = {
  key: 'ad_reply_hijack',
  description:
    '無関係なツイートへの返信を乗っ取り、広告・転職勧誘・暗号資産のギブアウェイ/エアドロップ勧誘を宣伝している',
  version: '1.1.0',
  evaluate(bundle) {
    const replies = bundle.recentTweets.filter((t) => t.isReply)
    const adPitchReplies = replies.filter((t) => AD_JOB_PITCH_PATTERN.test(t.fullText))
    const adReplyRatio = replies.length > 0 ? adPitchReplies.length / replies.length : 0
    const hasEnoughSample = replies.length >= MIN_REPLY_SAMPLE

    const value = hasEnoughSample && adReplyRatio >= AD_REPLY_RATIO_THRESHOLD
    const confidence = hasEnoughSample ? adReplyRatio : 0

    return {
      value,
      confidence,
      reason: `adPitchReplies=${adPitchReplies.length}/${replies.length} (ratio=${adReplyRatio.toFixed(2)})`,
    }
  },
}
