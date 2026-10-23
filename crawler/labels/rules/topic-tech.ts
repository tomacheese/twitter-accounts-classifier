import { combineAlternatives, toConfidence } from '../confidence'
import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// 英単語は無関係な複合語の内部に一致しないよう単語境界で判定し、
// 日本語は単語境界の概念が同様には成り立たないため部分一致のままとしている。
//
// プログラマ/プログラミングは、
// プログラム という語幹のみで判定すると、
// アフィリエイトプログラムやマイルプログラムなど技術と無関係な用法まで一致してしまうため、
// 具体的な語形に限定している。
//
// engineer は分野を問わずあらゆる技術者に使われる語であるため、
// 土木・機械・音響などソフトウェア以外の分野を示す語が直前にある場合は除外している。
// 該当分野のエンジニアであっても software/developer 等の他の技術シグナルを bio に含む場合は、
// それらの語で引き続き一致する。
const NON_SOFTWARE_ENGINEER_DISCIPLINE =
  'civil|mechanical|electrical|chemical|structural|controls?|audio|sound|recording|mixing|mastering|aerospace|industrial|process|petroleum|mining|nuclear|marine|agricultural|biomedical|automotive'

const TECH_PATTERN = new RegExp(
  String.raw`\b(developer|(?<!\b(?:${NON_SOFTWARE_ENGINEER_DISCIPLINE})[\s-])engineer|software|full[\s-]?stack)|エンジニア|プログラマ|プログラミング|開発者`,
  'i',
)

// 「ゲーム開発者さんをフォロー」のようにフォロー対象を述べる用法は本人の職業の申告ではないため、
// 職種語の直後にフォローが続く箇所は判定前に取り除く。
const FOLLOW_TARGET_PATTERN =
  /(?:開発者|エンジニア|プログラマ)(?:さん|の方|など|等)*(?:を|も)?(?:主に|メインに|中心に)*フォロー/g

const KEYWORD_SCORE = 0.8

export const topicTechRule: LabelRule = {
  key: 'topic_tech',
  description:
    'プロフィールの直接証拠、またはフォロー関係から技術/ソフトウェア開発との強い関連が示される',
  version: '1.3.2',
  usesFollowGraphSignal: true,
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch =
      bio !== null && TECH_PATTERN.test(bio.replaceAll(FOLLOW_TARGET_PATTERN, ''))
    const followGraph = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_tech)
    const value = keywordMatch || followGraph.matched
    const evidenceScore = combineAlternatives([
      keywordMatch ? KEYWORD_SCORE : 0,
      followGraph.evidenceScore,
    ])
    const evaluable = bio !== null || followGraph.evaluable
    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      reason: `bio tech-keyword match=${keywordMatch}, follow-graph match=${followGraph.matched}`,
      evaluable,
    }
  },
}
