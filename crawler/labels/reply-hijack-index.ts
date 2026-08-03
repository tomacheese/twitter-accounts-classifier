import { averagePairwiseSimilarity, normalizeForSimilarity } from './text-similarity'

const MIN_DISTINCT_AUTHORS = 5
const WINDOW_HOURS = 24
// しきい値をより低く設定すると、お悔やみの返信や祝福の連投、
// ハッシュタグ企画への便乗といった、自然な集団反応まで誤検知してしまうため、
// この値を採用している。しきい値の調整だけでは判定を完結できないため、
// 低努力アカウントかどうかの追加判定と組み合わせる。
const SIMILARITY_THRESHOLD = 0.1
// @mention を除去すると朝の挨拶のような定型的な短文リプライがごく少ない文字数になり、
// しきい値を上げても他の短い挨拶と高い類似度を示してしまうため、
// しきい値の調整だけでは真のなりすまし文言と挨拶文化アカウントを区別できない。
// そのためこの最小文字数によるフィルタで短すぎる定型文をあらかじめ除外する。
// 挨拶文化アカウントは元々リプライが多いため、
// 低努力アカウントの追加判定でも区別できない。
// duplicate-reply-index.ts でも同じ理由から同じ値を採用している。
//
// なお、多数のアカウントがそれぞれ長文で実質的な返信を書く自然な集団反応は、
// 長さ・類似度のいずれでもこのルールの対象パターンと区別できないため、
// 意図的に対象から外している。
const MIN_NORMALIZED_LENGTH = 20

export interface ReplyHijackCorpusEntry {
  accountId: string
  fullText: string
  inReplyToTweetId: string | null
  createdAt: Date
}

export interface ReplyHijackIndex {
  /**
   * @param accountId - 検索対象のアカウント
   * @param tweetId - このアカウントがリプライした対象ツイートのID
   * @returns このアカウント・対象ツイートの組が属する「reply-hijack swarm」の規模。
   *   属していない場合は0
   */
  swarmSizeFor(accountId: string, tweetId: string): number
}

/**
 * リプライツイートの corpus からアカウント横断の「reply-hijack swarm」検索用インデックスを構築する。
 * 同一著者が同一対象へ複数回リプライする挙動は `reply_flooding` の対象パターンであり
 * ここでは扱わないため、著者・対象ごとに最初の1件のみを扱う。
 * `swarmSizeFor` が返すのは構造上の swarm 所属情報のみであり、`reply_hijack_swarm`
 * ルールの判定には、アカウント自身のプロフィールが低努力に見えるという追加条件も必要になる。
 * @param corpus - クロール・再ラベリング実行全体から集めたリプライツイート
 * @returns アカウント・対象ツイートの組ごとに問い合わせるためのインデックス
 */
export function buildReplyHijackIndex(corpus: ReplyHijackCorpusEntry[]): ReplyHijackIndex {
  const firstReplyByAuthor = new Map<string, Map<string, ReplyHijackCorpusEntry>>()
  for (const entry of corpus) {
    if (entry.inReplyToTweetId === null) continue
    if (normalizeForSimilarity(entry.fullText).length < MIN_NORMALIZED_LENGTH) continue
    const byAuthor: Map<string, ReplyHijackCorpusEntry> =
      firstReplyByAuthor.get(entry.inReplyToTweetId) ?? new Map()
    const existing = byAuthor.get(entry.accountId)
    if (!existing) {
      byAuthor.set(entry.accountId, entry)
    } else if (entry.createdAt < existing.createdAt) {
      byAuthor.set(entry.accountId, entry)
    }
    firstReplyByAuthor.set(entry.inReplyToTweetId, byAuthor)
  }

  const swarmSizeByTarget = new Map<string, number>()
  const memberAccountsByTarget = new Map<string, Set<string>>()
  for (const [targetTweetId, byAuthor] of firstReplyByAuthor) {
    const replies = [...byAuthor.values()]
    if (replies.length < MIN_DISTINCT_AUTHORS) continue

    const timestamps = replies.map((r) => r.createdAt.getTime())
    const spanHours = (Math.max(...timestamps) - Math.min(...timestamps)) / (1000 * 60 * 60)
    if (spanHours > WINDOW_HOURS) continue

    const similarity = averagePairwiseSimilarity(replies.map((r) => r.fullText))
    if (similarity < SIMILARITY_THRESHOLD) continue

    swarmSizeByTarget.set(targetTweetId, replies.length)
    memberAccountsByTarget.set(targetTweetId, new Set(replies.map((r) => r.accountId)))
  }

  return {
    swarmSizeFor(accountId, tweetId) {
      const members = memberAccountsByTarget.get(tweetId)
      if (!members?.has(accountId)) return 0
      return swarmSizeByTarget.get(tweetId) ?? 0
    },
  }
}
