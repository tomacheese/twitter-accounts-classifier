import type { LabelRule } from '../types'

// Crypto giveaway/airdrop pitches sit alongside the job-change/ad-案件 terms because bot
// networks piling fake-giveaway and airdrop replies onto high-engagement tweets are the
// dominant reply-hijack pattern on X as of 2026, not just job-change solicitation.
// English terms are word-boundary-matched, as in the finance/tech/crypto topic rules, so
// they do not match inside unrelated words.
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
