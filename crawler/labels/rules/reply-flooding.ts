import type { LabelRule } from '../types'
import { averagePairwiseSimilarity } from '../text-similarity'

// This "impression zombie" (インプレゾンビ) archetype - paraphrased, sometimes AI-reworded or
// translated, replies piled onto one tweet - is covered by neither neighbouring rule:
// self_duplicate_reply requires a standalone-tweet/reply pair (this is reply-vs-reply), and
// templated_reply_network requires verbatim text shared across *different* accounts (this is
// paraphrased text repeated by the *same* account). Thresholds are calibrated against
// crawled samples: confirmed flood groups (8-27 replies to one tweet, spanning under a
// minute to a few hours) scored average bigram-Jaccard similarity 0.06-0.26, while an
// extended, topically unrelated chat session with one friend scored 0.011.
const MIN_REPLIES_TO_SAME_TARGET = 8
const WINDOW_HOURS = 24
const SIMILARITY_THRESHOLD = 0.03

// Used only to render a human-readable handle in the reason string. Grouping itself keys
// off `inReplyToTweetId` - see the comment on `groups` below for why.
const REPLY_TARGET_PATTERN = /^@(\w+)/

export const replyFloodingRule: LabelRule = {
  key: 'reply_flooding',
  description:
    '同一相手への返信を短時間のうちに大量投稿しており、その文面が言い換えや翻訳違いを含めて内容的に酷似している。1つのバズったツイートに大量の言い換えリプライを浴びせてインプレッションを稼ぐ「インプレゾンビ」の典型パターン',
  version: '1.1.0',
  evaluate(bundle) {
    // Grouping by the leading @mention (i.e. by the account being talked to) cannot
    // distinguish flooding from an ordinary two-way conversation: a back-and-forth chat, or
    // an argument, with one person trivially produces 8+ replies "to the same target" within
    // 24 hours, and the similarity floor does not separate them either (such conversations
    // scored 0.035-0.072, above the threshold). The structural difference is what the
    // replies are aimed at, not who: this archetype piles many replies onto ONE viral tweet,
    // whereas a conversation answers a different tweet each time. Every reply in the
    // production corpus carries an `inReplyToTweetId`, so nothing observable is lost by
    // grouping on it; replies whose parent id is unknown are skipped rather than lumped
    // together, since a missing id is not evidence that two replies share a target.
    const groups = new Map<string, { fullText: string; createdAt: Date }[]>()
    for (const tweet of bundle.recentTweets) {
      if (!tweet.isReply || tweet.isRetweet) continue
      const targetTweetId = tweet.inReplyToTweetId
      if (targetTweetId === null || targetTweetId === undefined) continue
      const group = groups.get(targetTweetId) ?? []
      group.push({ fullText: tweet.fullText, createdAt: tweet.createdAt })
      groups.set(targetTweetId, group)
    }

    let best: { target: string; count: number; similarity: number } | null = null
    for (const replies of groups.values()) {
      if (replies.length < MIN_REPLIES_TO_SAME_TARGET) continue

      const timestamps = replies.map((r) => r.createdAt.getTime())
      const spanHours = (Math.max(...timestamps) - Math.min(...timestamps)) / (1000 * 60 * 60)
      if (spanHours > WINDOW_HOURS) continue

      const similarity = averagePairwiseSimilarity(replies.map((r) => r.fullText))
      if (similarity < SIMILARITY_THRESHOLD) continue
      if (best === null || similarity > best.similarity) {
        const target = REPLY_TARGET_PATTERN.exec(replies[0].fullText)?.[1] ?? 'unknown'
        best = { target, count: replies.length, similarity }
      }
    }

    if (best === null) {
      return { value: false, confidence: 0, reason: 'no reply-flooding target found' }
    }

    const volumeSignal = Math.min(1, best.count / 20)
    const similaritySignal = Math.min(1, best.similarity / 0.15)
    const confidence = Math.min(1, volumeSignal * 0.4 + similaritySignal * 0.6)

    return {
      value: true,
      confidence,
      reason: `target=@${best.target}, replies=${best.count}, avgSimilarity=${best.similarity.toFixed(3)}`,
    }
  },
}
