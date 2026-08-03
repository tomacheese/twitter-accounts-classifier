import type { LabelRule } from '../types'

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
  description: 'X の投稿ごとの AI 生成メディア開示 (contentDisclosure) が直近ツイートに1件以上ある',
  version: '1.0.0',
  evaluate(bundle) {
    const flagged = bundle.recentTweets.filter((t) => t.hasAiGeneratedMedia === true)
    const value = flagged.length > 0

    const confidence = value
      ? Math.max(...flagged.map((t) => confidenceForSource(t.aiGeneratedDetectionSource)))
      : 0

    const sources = [...new Set(flagged.map((t) => t.aiGeneratedDetectionSource ?? 'unknown'))]

    return {
      value,
      confidence,
      reason: `aiGeneratedMediaTweetCount=${flagged.length} (n=${bundle.recentTweets.length}), sources=${sources.join(',') || 'none'}`,
    }
  },
}
