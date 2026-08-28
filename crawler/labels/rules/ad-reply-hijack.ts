import { posteriorProbabilityAtLeast, toConfidence } from '../confidence'
import type { AccountFeatureBundle, LabelRule } from '../types'

// 転職勧誘・広告案件系の語だけでなく暗号資産のギブアウェイ/エアドロップ勧誘も含めているのは、
// 高エンゲージメントツイートに偽ギブアウェイ・エアドロップの返信を量産するボットネットワークが、
// 転職勧誘単体より支配的な手口であるため。
// 英単語は他のトピック系ルールと同様に単語境界でマッチさせ、
// 無関係な単語の内部にはマッチしないようにしている。
const AD_JOB_PITCH_PATTERN =
  /転職(エージェント|活動|相談|しませんか|しよう)|求人|副業|案件情報|PR案件|広告案件|アフィリ|セミナー情報|無料相談|エアドロ(ップ)?|無料配布|プレゼント企画|\bgiveaway\b|\bairdrop\b|\bclaim\s*now\b|\bconnect\s*wallet\b|\bfree\s*mint\b/i

const MIN_REPLY_SAMPLE = 3
const AD_REPLY_RATIO_THRESHOLD = 0.5

/**
 * `screenName` を正規表現のリテラルとして安全に埋め込めるようエスケープする。
 * @param screenName - アカウントのスクリーンネーム
 * @returns 正規表現の特殊文字をエスケープした文字列
 */
function escapeForRegExp(screenName: string): string {
  return screenName.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`)
}

export const adReplyHijackRule: LabelRule = {
  key: 'ad_reply_hijack',
  description:
    '無関係なツイートへの返信を乗っ取り、広告・転職勧誘・暗号資産のギブアウェイ/エアドロップ勧誘を宣伝している',
  version: '1.4.0',
  evaluate(bundle) {
    const { screenName } = bundle.account
    // 親ツイートの投稿者情報はクロールデータに存在しないため、
    // 投稿者を辿って乗っ取りと自社企画対応を区別することはできない。
    // 代わりに、親ツイート本文が返信元アカウント自身への @mention を含むかどうかを見る。
    // 無関係な乗っ取り先のバズツイートが乗っ取り対象のアカウントに言及することは通常なく、
    // 逆に企画応募・問い合わせ等の双方向のやり取りでは応募者側が @mention するのが自然なため。
    const selfMentionPattern = new RegExp(String.raw`@${escapeForRegExp(screenName)}\b`, 'i')
    const isReplyToOwnMentioner = (t: AccountFeatureBundle['recentTweets'][number]): boolean =>
      t.parentTweetFullText != null && selfMentionPattern.test(t.parentTweetFullText)

    // リプライ先が自分自身の直近ツイートである場合、それは他者のツイートへの
    // 乗っ取りではなく、自分の宣伝文をスレッド内で連投しているだけであるため除外する。
    // `self_duplicate_reply` ルールの自己スレッド除外と同じ考え方。
    const ownTweetIds = new Set(bundle.recentTweets.map((t) => t.id))
    const replies = bundle.recentTweets.filter((t) => {
      if (!t.isReply) return false
      const isSelfThreadReply = t.inReplyToTweetId != null && ownTweetIds.has(t.inReplyToTweetId)
      return !isSelfThreadReply && !isReplyToOwnMentioner(t)
    })
    const adPitchReplies = replies.filter((t) => AD_JOB_PITCH_PATTERN.test(t.fullText))
    const adReplyRatio = replies.length > 0 ? adPitchReplies.length / replies.length : 0
    const hasEnoughSample = replies.length >= MIN_REPLY_SAMPLE

    const value = hasEnoughSample && adReplyRatio >= AD_REPLY_RATIO_THRESHOLD
    const evidenceScore = hasEnoughSample
      ? posteriorProbabilityAtLeast(adPitchReplies.length, replies.length, AD_REPLY_RATIO_THRESHOLD)
      : 0

    return {
      value,
      confidence: toConfidence(value, evidenceScore, hasEnoughSample),
      reason: `adPitchReplies=${adPitchReplies.length}/${replies.length} (ratio=${adReplyRatio.toFixed(2)})`,
      evaluable: hasEnoughSample,
    }
  },
}
