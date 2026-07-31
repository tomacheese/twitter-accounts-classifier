import type { LabelRule } from '../types'

// Restricted to Japanese-script detection (hiragana/katakana/kanji) rather than full
// language identification, matching this project's existing Japanese/English-focused
// keyword rules (topic_tech, topic_finance, etc.) - the crawl targets Japanese Twitter.
const JAPANESE_SCRIPT_PATTERN = /[぀-ヿ一-鿿]/

const MIN_SAMPLE_PER_SIDE = 3
const SCRIPT_MISMATCH_THRESHOLD = 0.7

function japaneseScriptRatio(texts: string[]): number {
  if (texts.length === 0) return 0
  return texts.filter((text) => JAPANESE_SCRIPT_PATTERN.test(text)).length / texts.length
}

// A reply whose text is nothing but a bare t.co link scores as script-ratio 0 regardless of
// language, since it carries no linguistic content to begin with - that is an empty sample,
// not evidence of a language *mismatch*, and a dozen such replies drive `replyJapaneseRatio`
// to 0.00 by construction. Strip URLs/mentions/the self-retweet prefix and require genuine
// remaining text before counting a tweet toward either side of the ratio.
function hasLinguisticContent(text: string): boolean {
  const stripped = text
    .replace(/^RT @\w+:\s*/i, '')
    .replaceAll(/https?:\/\/\S+/gi, '')
    .replaceAll(/@\w+/g, '')
    .trim()
  return stripped.length > 0
}

export const replyLanguageMismatchRule: LabelRule = {
  key: 'reply_language_mismatch',
  description:
    '自身のツイートは特定の言語体系にほぼ偏っているが、リプライ(自身のリプライを自己リツイートしているものを含む)では無関係な対象読者向けに突然言語が切り替わる。エンゲージメント稼ぎボットネットワークの特徴',
  version: '1.2.0',
  evaluate(bundle) {
    const { screenName } = bundle.account
    const ownPosts = bundle.recentTweets.filter(
      (t) => !t.isReply && !t.isRetweet && hasLinguisticContent(t.fullText),
    )

    // A "retweet" whose quoted text is credited to the account's own screen name is not
    // genuine third-party content - it is the account amplifying its own reply, which is
    // where the mismatched-language reply content actually lives in confirmed cases: those
    // accounts retweet their own replies rather than leaving them as plain replies.
    //
    // The content after that prefix must itself look like a reply (start with an
    // `@mention`), otherwise this also matches link-only self-retweets (e.g.
    // `RT @screenName: https://t.co/xxx` with no reply text at all), which score as
    // script-ratio 0 regardless of the account's actual reply language.
    const selfRetweetPrefix = `RT @${screenName}:`
    const isSelfRetweetedReply = (text: string): boolean =>
      text.startsWith(selfRetweetPrefix) &&
      text.slice(selfRetweetPrefix.length).trimStart().startsWith('@')
    const replies = bundle.recentTweets.filter(
      (t) =>
        (t.isReply || (t.isRetweet && isSelfRetweetedReply(t.fullText))) &&
        hasLinguisticContent(t.fullText),
    )

    const hasEnoughSample =
      ownPosts.length >= MIN_SAMPLE_PER_SIDE && replies.length >= MIN_SAMPLE_PER_SIDE
    const ownJapaneseRatio = japaneseScriptRatio(ownPosts.map((t) => t.fullText))
    const replyJapaneseRatio = japaneseScriptRatio(replies.map((t) => t.fullText))
    const mismatch = Math.abs(ownJapaneseRatio - replyJapaneseRatio)

    const value = hasEnoughSample && mismatch >= SCRIPT_MISMATCH_THRESHOLD
    const confidence = hasEnoughSample ? mismatch : 0

    return {
      value,
      confidence,
      reason: `ownJapaneseRatio=${ownJapaneseRatio.toFixed(2)} (n=${ownPosts.length}), replyJapaneseRatio=${replyJapaneseRatio.toFixed(2)} (n=${replies.length})`,
    }
  },
}
