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

interface WindowStats {
  targetCount: number
  replyCount: number
  spanHours: number
}

interface GroupStats extends WindowStats {
  normalizedText: string
}

function computeWindowStats(anchor: ReplyEntry, sortedEntries: ReplyEntry[]): WindowStats {
  const windowStart = anchor.createdAt.getTime()
  const windowEndLimit = windowStart + WINDOW_HOURS * 60 * 60 * 1000
  const windowEntries = sortedEntries.filter((e) => {
    const time = e.createdAt.getTime()
    return time >= windowStart && time <= windowEndLimit
  })
  const windowEnd = Math.max(...windowEntries.map((e) => e.createdAt.getTime()))
  return {
    targetCount: new Set(windowEntries.map((e) => e.targetTweetId)).size,
    replyCount: windowEntries.length,
    spanHours: (windowEnd - windowStart) / (1000 * 60 * 60),
  }
}

function findBestWindow(entries: ReplyEntry[]): WindowStats {
  // eslint-disable-next-line unicorn/no-array-sort
  const sorted = [...entries].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  // sorted は呼び出し元(evaluate)で必ず1件以上のグループにのみ渡されるため、先頭要素を初期値にできる
  let best = computeWindowStats(sorted[0], sorted)
  for (const anchor of sorted.slice(1)) {
    const candidate = computeWindowStats(anchor, sorted)
    if (candidate.targetCount > best.targetCount) {
      best = candidate
    }
  }
  return best
}

function computeGroupStats(normalizedText: string, entries: ReplyEntry[]): GroupStats {
  return { normalizedText, ...findBestWindow(entries) }
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
