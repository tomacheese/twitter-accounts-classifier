import { combineAlternatives, toConfidence } from '../confidence'
import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// 素の "beauty" は美容と無関係な慣用句や宣伝文句 (旅先の景観、ジュエリーの謳い文句など) にも
// 頻出するため対象外とし、より限定的な複合語のみに一致させている。
// メイクへの否定後読みは、ヘアメイクへの一致を保ったまま誤検知の多いリメイクの部分一致を除外するため。
const BEAUTY_PATTERN = /コスメ|美容|(?<!リ)メイク|スキンケア|\b(cosmetics?|skincare|makeup)\b/i

// 素の「美容」は「美容系の優待株」のような株式投資セクターの呼称としても使われ、
// この場合は投資対象への言及であって美容そのものへの関心を示さない。
// 他のキーワード (コスメ/メイク/スキンケア) は投資文脈での用例が見られないため対象外とする。
const FINANCE_SECTOR_CONTEXT_WINDOW_LENGTH = 10
const FINANCE_SECTOR_CONTEXT_PATTERN = /株|銘柄|優待|証券|ファンド/

function isFinanceSectorMention(bio: string, match: RegExpMatchArray): boolean {
  if (match[0] !== '美容' || match.index === undefined) return false
  const after = bio.slice(
    match.index + match[0].length,
    match.index + match[0].length + FINANCE_SECTOR_CONTEXT_WINDOW_LENGTH,
  )
  return FINANCE_SECTOR_CONTEXT_PATTERN.test(after)
}

// 最初の一致だけ見ると、投資文脈の「美容」の後に本物のキーワードが続く場合を取りこぼす。
// そのため全ての一致を確認し、いずれかが有効であれば true とする。
function hasGenuineBeautyKeyword(bio: string): boolean {
  const matches = bio.matchAll(new RegExp(BEAUTY_PATTERN, `${BEAUTY_PATTERN.flags}g`))
  for (const match of matches) {
    if (!isFinanceSectorMention(bio, match)) return true
  }
  return false
}

const KEYWORD_SCORE = 0.8

export const topicBeautyRule: LabelRule = {
  key: 'topic_beauty',
  description:
    'プロフィールの直接証拠、またはフォロー関係から美容・コスメ・スキンケアとの強い関連が示される',
  version: '1.0.2',
  usesFollowGraphSignal: true,
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch = bio !== null && hasGenuineBeautyKeyword(bio)
    const followGraph = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_beauty)
    const value = keywordMatch || followGraph.matched
    const evidenceScore = combineAlternatives([
      keywordMatch ? KEYWORD_SCORE : 0,
      followGraph.evidenceScore,
    ])
    const evaluable = bio !== null || followGraph.evaluable
    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      reason: `bio beauty-keyword match=${keywordMatch}, follow-graph match=${followGraph.matched}`,
      evaluable,
    }
  },
}
