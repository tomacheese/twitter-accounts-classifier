import { combineAlternatives, toConfidence } from '../confidence'
import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// topic_anime はアニメ・漫画を鑑賞する関心を対象としているのに対し、
// 本ルールは自ら絵を描いて発信している申告を対象とする、
// 別軸のシグナルとして扱っている。
// 英単語は無関係な複合語の内部に一致しないよう単語境界で判定し、
// 日本語は本プロジェクトの topic_* ルール群の慣例に倣い部分一致としている。
// 「推し絵師」「好きな絵師」は別の絵師への言及にすぎず、本人の制作申告ではない。
const ILLUSTRATION_PATTERN = /イラスト|(?<!推し|好きな)絵師|絵描き|\billustrator\b|pixiv/i

// pixiv は小説の投稿先でもあるため、小説書きの bio では pixiv の記載だけで絵の申告とはみなさない。
const PIXIV_ONLY_PATTERN = /pixiv/i
const NOVEL_WRITER_PATTERN = /小説|ノベル(?!ティ)|\bnovel(?!ty)/i
const DRAWING_WORD_PATTERN = /イラスト|絵師|絵描き|絵を|描[くきい]|\billustrator\b/i

// 「イラスト提供：〇〇様」は、アカウント本人ではなく別の絵師にイラストを
// 依頼・提供してもらったことを示すクレジット表記であり、
// 本人が描いて発信している申告ではないため除外する。
const ILLUSTRATION_CREDIT_TO_OTHERS_PATTERN = /イラスト.{0,4}提供.{0,15}(様|さん|氏)/

// 「ヘッダーのイラストは〇〇さん」のように、ヘッダーやアイコンの制作者を示す表記は、
// 他の記述まで打ち消さないよう、その部分だけを取り除いてからキーワードを判定する。
const ILLUSTRATION_HEADER_CREDIT_PATTERN =
  /(?:ヘッダー?|アイコン|header|icon)(?:の?イラスト)?(?:は|[:：])[^\n。]{0,20}(?:さん|様|氏)/gi

// 他者のイラストをリツイートしていると述べるだけの bio は、
// 本人が描いて発信している申告ではないため除外する。
const ILLUSTRATION_RETWEET_ONLY_PATTERN =
  /イラスト[^\n。]{0,12}(?:RT|リツイート|リポスト)(?:します|しています|してます|しがち)/i

const KEYWORD_SCORE = 0.8

export const topicIllustrationRule: LabelRule = {
  key: 'topic_illustration',
  description:
    'プロフィールの直接証拠、またはフォロー関係からイラスト制作/投稿との強い関連が示される',
  version: '1.5.1',
  usesFollowGraphSignal: true,
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch =
      bio !== null &&
      ILLUSTRATION_PATTERN.test(bio.replaceAll(ILLUSTRATION_HEADER_CREDIT_PATTERN, ' ')) &&
      !ILLUSTRATION_CREDIT_TO_OTHERS_PATTERN.test(bio) &&
      !ILLUSTRATION_RETWEET_ONLY_PATTERN.test(bio) &&
      !(
        PIXIV_ONLY_PATTERN.test(bio) &&
        NOVEL_WRITER_PATTERN.test(bio) &&
        !DRAWING_WORD_PATTERN.test(bio)
      )
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
