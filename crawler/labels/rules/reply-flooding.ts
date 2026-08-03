import type { LabelRule } from '../types'
import { averagePairwiseSimilarity } from '../text-similarity'

// この「インプレゾンビ」的なアーキタイプ(言い換えや、
// 時には AI による書き換え・翻訳を伴うリプライを1つのツイートに大量投稿する)は、
// 隣接する他ルールでは捕捉できない。
// self_duplicate_reply は単独ツイートとリプライのペアを要求し(これはリプライ同士の比較)、
// templated_reply_network は別アカウント間の一字一句同一テキストを要求する。
// こちらは同一アカウントによる言い換えの繰り返しであるため。
const MIN_REPLIES_TO_SAME_TARGET = 8
const WINDOW_HOURS = 24
const SIMILARITY_THRESHOLD = 0.03

// reason 文字列にハンドルを人が読める形で表示するためだけに使う。
// グルーピング自体は `inReplyToTweetId` を基準に行う。
const REPLY_TARGET_PATTERN = /^@(\w+)/

export const replyFloodingRule: LabelRule = {
  key: 'reply_flooding',
  description:
    '同一相手への返信を短時間のうちに大量投稿しており、その文面が言い換えや翻訳違いを含めて内容的に酷似している。1つのバズったツイートに大量の言い換えリプライを浴びせてインプレッションを稼ぐ「インプレゾンビ」の典型パターン',
  version: '1.1.0',
  evaluate(bundle) {
    // 先頭の @メンション(会話相手)でグルーピングすると、
    // 通常の相互会話との区別ができない。一人との往復チャットや口論でも、
    // 24時間以内に「同じ相手への」複数のリプライが容易に発生し、
    // 類似度の下限でも区別できないため。
    // 構造的な違いは「相手が誰か」ではなく「何に対するリプライか」にあり、
    // このアーキタイプは1つのバズったツイートに大量のリプライを積み上げるのに対し、
    // 通常の会話では毎回異なるツイートに返信する。
    // 本番データのリプライはすべて `inReplyToTweetId` を持つため、
    // これを基準にグルーピングしても失われる情報はなく、
    // 親ツイート ID が不明なリプライは同一グループとみなさずスキップする。
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
