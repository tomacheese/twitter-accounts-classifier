import { averagePairwiseSimilarity, normalizeForSimilarity } from './text-similarity'
import type { ReplyHijackEvidenceDetails } from '../db/reply-hijack-evidence-repository'

// 独立した批判・指摘の語彙的収束(例:複数アカウントが独立に無断転用を指摘する)を、
// 定型追従型の reply-hijack swarm と区別するための判定。
// テキスト類似度の閾値を上げる、または決まり文句を除去するだけでは対応できない。
// 真の swarm も独立した批判も、語彙が収束する点では同型であり、
// 類似度だけでは区別できないためである。
// エンゲージメント稼ぎ目的の定型追従リプライは称賛・便乗が大半を占め、
// 批判・指摘語彙が支配的になることは通常ない。
// そのため、批判・指摘語彙の有無という意味内容ベースの軽量なシグナルで区別する。
const CRITICISM_VOCAB_PATTERN =
  /無断転用|無断使用|無断掲載|パクリ|盗用|剽窃|著作権侵害|クレジット表記|出典(を明記|明示)|引用元を明記/
const MIN_CRITICISM_FRACTION = 0.6

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
  tweetId: string
  accountId: string
  fullText: string
  inReplyToTweetId: string | null
  createdAt: Date
}

export interface ReplyHijackIndex {
  /**
   * @param accountId - 検索対象のアカウント
   * @param tweetId - このアカウントがリプライした対象ツイートの ID
   * @returns このアカウント・対象ツイートの組が属する「reply-hijack swarm」の規模。
   *   属していない場合は 0
   */
  swarmSizeFor(accountId: string, tweetId: string): number
  /**
   * @param accountId - 検索対象のアカウント
   * @param tweetId - このアカウントがリプライした対象ツイートの ID
   * @returns このアカウント・対象ツイートの組が structural screening の条件 (`MIN_DISTINCT_AUTHORS` 等) を満たすか
   */
  isEligibleForScreening(accountId: string, tweetId: string): boolean
  /**
   * @param accountId - 検索対象のアカウント
   * @param tweetId - このアカウントがリプライした対象ツイートの ID
   * @returns 対象アカウントが属する swarm の監査証跡。属していない場合は `undefined`
   */
  evidenceFor(accountId: string, tweetId: string): ReplyHijackEvidenceDetails | undefined
}

/**
 * リプライツイートの corpus からアカウント横断の「reply-hijack swarm」検索インデックスを構築する。
 * 同一著者が同一対象へ複数回リプライする挙動は `reply_flooding` の対象でありここでは扱わないため、
 * 著者・対象ごとに最初の1件のみを扱う。
 * `swarmSizeFor` が返すのは構造上の swarm 所属情報のみであり、
 * `reply_hijack_swarm` ルールの判定には、
 * アカウント自身のプロフィールが低努力に見えるという追加条件も必要になる。
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

  const evidenceByTarget = new Map<string, ReplyHijackEvidenceDetails>()
  const memberAccountsByTarget = new Map<string, Set<string>>()
  for (const [targetTweetId, byAuthor] of firstReplyByAuthor) {
    const replies = [...byAuthor.values()]
    if (replies.length < MIN_DISTINCT_AUTHORS) continue

    const timestamps = replies.map((r) => r.createdAt.getTime())
    const spanHours = (Math.max(...timestamps) - Math.min(...timestamps)) / (1000 * 60 * 60)
    if (spanHours > WINDOW_HOURS) continue

    const similarity = averagePairwiseSimilarity(replies.map((r) => r.fullText))
    if (similarity < SIMILARITY_THRESHOLD) continue

    const criticismCount = replies.filter((r) => CRITICISM_VOCAB_PATTERN.test(r.fullText)).length
    if (criticismCount / replies.length >= MIN_CRITICISM_FRACTION) continue

    evidenceByTarget.set(targetTweetId, {
      targetTweetId,
      swarmSize: replies.length,
      averageSimilarity: similarity,
      spanHours,
      replyTweetIds: replies.map((reply) => reply.tweetId).toSorted(),
    })
    memberAccountsByTarget.set(targetTweetId, new Set(replies.map((r) => r.accountId)))
  }

  return {
    swarmSizeFor(accountId, tweetId) {
      const members = memberAccountsByTarget.get(tweetId)
      if (!members?.has(accountId)) return 0
      return evidenceByTarget.get(tweetId)?.swarmSize ?? 0
    },
    isEligibleForScreening(accountId, tweetId) {
      return memberAccountsByTarget.get(tweetId)?.has(accountId) ?? false
    },
    evidenceFor(accountId, tweetId) {
      if (!memberAccountsByTarget.get(tweetId)?.has(accountId)) return undefined
      return evidenceByTarget.get(tweetId)
    },
  }
}
