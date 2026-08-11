import { createHash } from 'node:crypto'
import type { LabelRule } from '../types'
import { normalizeReplyText } from '../duplicate-reply-index'

const MIN_DISTINCT_TARGETS = 5
const WINDOW_HOURS = 24
const CONFIDENCE_DIVISOR = 10
const TEXT_HASH_LENGTH = 16

interface ReplyEntry {
  targetTweetId: string
  createdAt: Date
}

interface GroupStats {
  normalizedText: string
  targetCount: number
  replyCount: number
  spanHours: number
}

function computeGroupStats(normalizedText: string, entries: ReplyEntry[]): GroupStats {
  const timestamps = entries.map((e) => e.createdAt.getTime())
  const spanHours = (Math.max(...timestamps) - Math.min(...timestamps)) / (1000 * 60 * 60)
  const targetCount = new Set(entries.map((e) => e.targetTweetId)).size
  return { normalizedText, targetCount, replyCount: entries.length, spanHours }
}

function buildReason(stats: GroupStats): string {
  const textHash = createHash('sha256')
    .update(stats.normalizedText)
    .digest('hex')
    .slice(0, TEXT_HASH_LENGTH)
  return `targetCount=${stats.targetCount}, replies=${stats.replyCount}, spanHours=${stats.spanHours.toFixed(1)}, textHash=${textHash}`
}

export const crossTargetTemplatedReplyRule: LabelRule = {
  key: 'cross_target_templated_reply',
  description:
    '同一または実質同一の定型リプライを、短時間のうちに複数の異なる親ツイートへ反復投稿している。インプレッション獲得目的のアカウントが異なるバズ投稿へ同じ賞賛文・誘導文を大量に返信する典型パターン',
  version: '1.0.0',
  evaluate(bundle) {
    const groups = new Map<string, ReplyEntry[]>()
    for (const tweet of bundle.recentTweets) {
      if (!tweet.isReply || tweet.isRetweet) continue
      const targetTweetId = tweet.inReplyToTweetId
      if (targetTweetId === null || targetTweetId === undefined) continue
      const normalized = normalizeReplyText(tweet.fullText)
      if (normalized === '') continue
      const group = groups.get(normalized) ?? []
      group.push({ targetTweetId, createdAt: tweet.createdAt })
      groups.set(normalized, group)
    }

    let best: GroupStats | null = null
    for (const [normalizedText, entries] of groups) {
      const stats = computeGroupStats(normalizedText, entries)
      if (stats.spanHours > WINDOW_HOURS) continue
      if (stats.targetCount < MIN_DISTINCT_TARGETS) continue
      if (best === null || stats.targetCount > best.targetCount) {
        best = stats
      }
    }

    if (best === null) {
      return { value: false, confidence: 0, reason: 'no cross-target templated reply group found' }
    }

    return {
      value: true,
      confidence: Math.min(1, best.targetCount / CONFIDENCE_DIVISOR),
      reason: buildReason(best),
    }
  },
}
