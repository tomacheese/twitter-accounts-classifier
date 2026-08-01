import type { LabelRule } from '../types'

const MIN_QUOTE_SAMPLE = 3

export const videoRepostRule: LabelRule = {
  key: 'video_repost',
  description: '他者が投稿した動画付きツイートを引用ツイートし、自分のコメントを付けている',
  version: '1.0.0',
  evaluate(bundle) {
    const candidates = bundle.recentTweets.filter(
      (t) =>
        t.quotedTweetAuthorId != null &&
        t.quotedTweetAuthorId !== bundle.account.id &&
        t.quotedTweetHasVideo === true,
    )
    const value = candidates.length >= MIN_QUOTE_SAMPLE

    return {
      value,
      confidence: value ? 1 : 0,
      reason: `videoRepostQuoteCount=${candidates.length} (n=${bundle.recentTweets.length})`,
    }
  },
}
