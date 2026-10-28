import { toConfidence } from '../confidence'
import type { LabelRule } from '../types'
import { isRecentTweetsEvaluable } from '../recent-tweets-evaluable'

/**
 * `aiGeneratedDetectionSource` の値ごとに割り当てる confidence。各判定方法の信頼度を反映する。
 * - `C2paClient`: 編集ツールやカメラが署名する C2PA の暗号学的来歴メタデータをメディアが持つ場合。
 *   改ざん検知可能な最も強い根拠のため最高値にする。
 * - `UserDeclared`: 投稿者自身が AI 生成であると自己申告した場合。一次情報による直接的な申告だが、
 *   自己申告は不正確・未申告になり得るため、暗号学的根拠よりわずかに低くする。
 * - `ContentDisclosureAiGeneratedDisclosure`: X 自身の自動/プラットフォーム側判定。
 *   誤検知率が不明な第三者分類器のため、既知の3種のなかでは最も低くしつつも、
 *   単なるフラグよりは明確に高くする。
 * - 出典不明/欠落（`hasAiGeneratedMedia` が true だが認識できる出典文字列がない場合）:
 *   開示自体は存在するがその来歴を判断できないため、保守的な中間値を用いる。
 */
const CONFIDENCE_BY_DETECTION_SOURCE: Record<string, number> = {
  C2paClient: 1,
  UserDeclared: 0.9,
  ContentDisclosureAiGeneratedDisclosure: 0.75,
}
const UNKNOWN_SOURCE_CONFIDENCE = 0.6
const MIN_TWEETS_FOR_EVALUATION = 2

/**
 * フラグが立った1件のツイートについて、その検出出典から confidence を求める。
 * 出典が欠落または未認識の場合は {@link UNKNOWN_SOURCE_CONFIDENCE} にフォールバックする。
 * @param source - ツイートの `aiGeneratedDetectionSource`
 * @returns このツイートの開示情報に割り当てる confidence
 */
function confidenceForSource(source: string | null | undefined): number {
  if (source === null || source === undefined) return UNKNOWN_SOURCE_CONFIDENCE
  return CONFIDENCE_BY_DETECTION_SOURCE[source] ?? UNKNOWN_SOURCE_CONFIDENCE
}

export const tweetAiGeneratedMediaRule: LabelRule = {
  key: 'tweet_ai_generated_media',
  description:
    'X の投稿ごとの AI 生成メディア開示 (contentDisclosure) が直近の自身のツイート (リツイートを除く) に1件以上ある。自身の保存ツイートが 2 件未満の場合は根拠不足として判定対象外にする (C2PA 由来の開示は除く)。陽性がなく、開示の有無を判定済みのツイートが 2 件未満の場合も判定対象外にする',
  version: '1.3.0',
  evaluate(bundle) {
    if (!isRecentTweetsEvaluable(bundle)) {
      return {
        value: false,
        confidence: 0.5,
        reason: 'recentTweets not evaluable',
        evaluable: false,
      }
    }

    // リツイートの開示は元の投稿者のものであり、このアカウントの投稿として数えない。
    const ownTweets = bundle.recentTweets.filter((t) => !t.isRetweet)

    // 保存ツイートが 1 件以下では根拠不足のため、フラグが立っていても陽性にしない。
    // ただし C2PA は改ざん検知可能な来歴で単独でも十分な根拠になるため対象外とする。
    const hasC2paEvidence = ownTweets.some(
      (t) => t.hasAiGeneratedMedia === true && t.aiGeneratedDetectionSource === 'C2paClient',
    )
    if (ownTweets.length < MIN_TWEETS_FOR_EVALUATION && !hasC2paEvidence) {
      return {
        value: false,
        confidence: 0.5,
        reason: `too few own recentTweets (n=${ownTweets.length})`,
        evaluable: false,
      }
    }

    const flagged = ownTweets.filter((t) => t.hasAiGeneratedMedia === true)
    const value = flagged.length > 0

    // hasAiGeneratedMedia が null の行は判定自体が行われていないため、陰性の根拠に数えない。
    const evaluatedCount = ownTweets.filter(
      (t) => t.hasAiGeneratedMedia !== null && t.hasAiGeneratedMedia !== undefined,
    ).length
    if (!value && evaluatedCount < MIN_TWEETS_FOR_EVALUATION) {
      return {
        value: false,
        confidence: 0.5,
        reason: `too few evaluated recentTweets (n=${evaluatedCount} of ${ownTweets.length})`,
        evaluable: false,
      }
    }

    const evidenceScore = value
      ? Math.max(...flagged.map((t) => confidenceForSource(t.aiGeneratedDetectionSource)))
      : 0
    const confidence = toConfidence(value, evidenceScore)

    const sources = [...new Set(flagged.map((t) => t.aiGeneratedDetectionSource ?? 'unknown'))]

    return {
      value,
      confidence,
      reason: `aiGeneratedMediaTweetCount=${flagged.length} (n=${ownTweets.length}), sources=${sources.join(',') || 'none'}`,
    }
  },
}
