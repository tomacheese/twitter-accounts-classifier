import { createHash } from 'node:crypto'
import { rampScore, toConfidence } from '../confidence'
import type { LabelRule } from '../types'
import { normalizeReplyText } from '../duplicate-reply-index'
import { isRecentTweetsEvaluable } from '../recent-tweets-evaluable'

const MIN_DISTINCT_TARGETS = 5
const WINDOW_HOURS = 24
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

function isBetterWindow(candidate: WindowStats, current: WindowStats): boolean {
  if (candidate.targetCount !== current.targetCount)
    return candidate.targetCount > current.targetCount
  if (candidate.replyCount !== current.replyCount) return candidate.replyCount > current.replyCount
  return candidate.spanHours < current.spanHours
}

function isBetterGroup(candidate: GroupStats, current: GroupStats): boolean {
  if (candidate.targetCount !== current.targetCount)
    return candidate.targetCount > current.targetCount
  if (candidate.replyCount !== current.replyCount) return candidate.replyCount > current.replyCount
  if (candidate.spanHours !== current.spanHours) return candidate.spanHours < current.spanHours
  return candidate.normalizedText < current.normalizedText
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
  // group は push によってのみ生成されるため必ず1件以上あり、先頭要素を初期値にできる
  let best = computeWindowStats(sorted[0], sorted)
  for (const anchor of sorted.slice(1)) {
    const candidate = computeWindowStats(anchor, sorted)
    if (isBetterWindow(candidate, best)) {
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
  version: '1.2.0',
  evaluate(bundle) {
    // 自分自身の過去ツイートへの返信はスレッド内の連投であり、
    // 異なる他者への反復投稿という本ルールの検出対象ではないため除外する
    const ownTweetIds = new Set(bundle.recentTweets.map((tweet) => tweet.id))
    const groups = new Map<string, ReplyEntry[]>()
    for (const tweet of bundle.recentTweets) {
      if (!tweet.isReply || tweet.isRetweet) continue
      const targetTweetId = tweet.inReplyToTweetId
      if (targetTweetId === null || targetTweetId === undefined) continue
      if (ownTweetIds.has(targetTweetId)) continue
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
      if (best === null || isBetterGroup(stats, best)) {
        best = stats
      }
    }

    if (best === null) {
      // recentTweets が未取得の場合、単に対象が無いだけの陰性とは区別する。
      const evaluable = isRecentTweetsEvaluable(bundle)
      return {
        value: false,
        confidence: toConfidence(false, 0, evaluable),
        reason: 'no cross-target templated reply group found',
        evaluable,
      }
    }

    const evidenceScore = rampScore(best.targetCount, MIN_DISTINCT_TARGETS, 5, 'higher-is-positive')
    return {
      value: true,
      confidence: toConfidence(true, evidenceScore),
      reason: buildReason(best),
    }
  },
}
