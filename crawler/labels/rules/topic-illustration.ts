import { combineAlternatives, toConfidence } from '../confidence'
import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// topic_anime はアニメ・漫画を鑑賞する関心を対象としているのに対し、
// 本ルールは自ら絵を描いて発信している申告を対象とする、
// 別軸のシグナルとして扱っている。
// 英単語は無関係な複合語の内部に一致しないよう単語境界で判定し、
// 日本語は本プロジェクトの topic_* ルール群の慣例に倣い部分一致としている。
const ILLUSTRATION_PATTERN = /イラスト|絵師|絵描き|\billustrator\b|pixiv/i

// 「イラスト提供：〇〇様」は、アカウント本人ではなく別の絵師にイラストを
// 依頼・提供してもらったことを示すクレジット表記であり、
// 本人が描いて発信している申告ではないため除外する。
const ILLUSTRATION_CREDIT_TO_OTHERS_PATTERN = /イラスト.{0,4}提供.{0,15}(様|さん|氏)/

const KEYWORD_SCORE = 0.8

export const topicIllustrationRule: LabelRule = {
  key: 'topic_illustration',
  description:
    'プロフィールの直接証拠、またはフォロー関係からイラスト制作/投稿との強い関連が示される',
  version: '1.2.0',
  usesFollowGraphSignal: true,
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch =
      bio !== null &&
      ILLUSTRATION_PATTERN.test(bio) &&
      !ILLUSTRATION_CREDIT_TO_OTHERS_PATTERN.test(bio)
    const followGraph = hasFollowGraphTopicSignal(
      bundle.followGraphLabelSignals?.topic_illustration,
    )
    const value = keywordMatch || followGraph.matched
    const evidenceScore = combineAlternatives([
      keywordMatch ? KEYWORD_SCORE : 0,
      followGraph.evidenceScore,
    ])
    const evaluable = bio !== null || followGraph.evaluable
    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      reason: `bio illustration-keyword match=${keywordMatch}, follow-graph match=${followGraph.matched}`,
      evaluable,
    }
  },
}
