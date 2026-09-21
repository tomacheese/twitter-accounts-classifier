import { combineAlternatives, toConfidence } from '../confidence'
import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// 「筋肉痛」のような無関係な複合語まで拾わないよう、
// 単独の「筋肉」ではなく訓練・活動としての愛好を明示する複合語のみを対象とする。
const FITNESS_PATTERN =
  /筋トレ|フィットネス|ボディメイク|ジム通い|パーソナルトレーニング|自重トレ|\b(?:fitness|workout|gym\s*rat)\b/i

// 「筋トレは全くしません」のように語を挙げたうえで実践を否定する bio は、
// フィットネスとの関連を示さないため、語の直後・直前の否定表現で除外する。
const FITNESS_DENIAL_AFTER_PATTERN =
  /^(?:は|も|を)?(?:一切|全く|全然)?(?:しない(?!と)|しません|してない|していない|やらない(?!より)|やりません)/
const FITNESS_DENIAL_BEFORE_PATTERN =
  /\b(?:never|don'?t|do not)\s+(?:do|did|go|train|lift|exercise)\b[^.\n]{0,15}$/i

function hasAffirmedFitnessKeyword(bio: string): boolean {
  const globalPattern = new RegExp(FITNESS_PATTERN.source, 'gi')
  return [...bio.matchAll(globalPattern)].some((match) => {
    const before = bio.slice(0, match.index)
    const after = bio.slice(match.index + match[0].length)
    return !FITNESS_DENIAL_AFTER_PATTERN.test(after) && !FITNESS_DENIAL_BEFORE_PATTERN.test(before)
  })
}

const KEYWORD_SCORE = 0.8

export const topicFitnessRule: LabelRule = {
  key: 'topic_fitness',
  description: 'プロフィールの直接証拠、またはフォロー関係からフィットネスとの強い関連が示される',
  version: '1.1.0',
  usesFollowGraphSignal: true,
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch = bio !== null && hasAffirmedFitnessKeyword(bio)
    const followGraph = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_fitness)
    const value = keywordMatch || followGraph.matched
    const evidenceScore = combineAlternatives([
      keywordMatch ? KEYWORD_SCORE : 0,
      followGraph.evidenceScore,
    ])
    const evaluable = bio !== null || followGraph.evaluable
    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      reason: `bio fitness-keyword match=${keywordMatch}, follow-graph match=${followGraph.matched}`,
      evaluable,
    }
  },
}
