import type { LabelRule } from '../types'

const CREDIT_PATTERN =
  /\bcredit\s*[:：]|\bcr\s*[:：]|\bvia\s*@|\bh\/t\b|courtesy\s*of|出典|引用元|元動画|提供\s*[:：]/i

const MIN_QUOTE_SAMPLE = 3
const UNCREDITED_RATIO_THRESHOLD = 0.5

export const videoRepostNoCreditRule: LabelRule = {
  key: 'video_repost_no_credit',
  description:
    '他者が投稿した動画付きツイートを引用し、元投稿者へのクレジット表記なしで自分のコメントを付けている',
  version: '1.0.0',
  evaluate(bundle) {
    const candidates = bundle.recentTweets.filter(
      (t) =>
        t.quotedTweetAuthorId != null &&
        t.quotedTweetAuthorId !== bundle.account.id &&
        t.quotedTweetHasVideo === true,
    )
    const uncredited = candidates.filter((t) => !CREDIT_PATTERN.test(t.fullText))
    const ratio = candidates.length > 0 ? uncredited.length / candidates.length : 0
    const hasEnoughSample = candidates.length >= MIN_QUOTE_SAMPLE

    const value = hasEnoughSample && ratio >= UNCREDITED_RATIO_THRESHOLD
    const confidence = hasEnoughSample ? ratio : 0

    return {
      value,
      confidence,
      reason: `uncreditedVideoQuotes=${uncredited.length}/${candidates.length} (ratio=${ratio.toFixed(2)})`,
    }
  },
}
