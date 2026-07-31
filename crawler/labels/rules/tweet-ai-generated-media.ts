import type { LabelRule } from '../types'

/**
 * Confidence assigned per `aiGeneratedDetectionSource` value, reflecting how reliable
 * each detection method is:
 * - `C2paClient`: the media carries C2PA cryptographic provenance metadata (e.g. from an
 *   editing tool or camera that signs its output) - the strongest, tamper-evident signal
 *   available, so it gets the highest confidence.
 * - `UserDeclared`: the poster self-disclosed the media is AI-generated - a direct
 *   first-party admission, but self-reporting can be inaccurate or omitted, so it's rated
 *   slightly below the cryptographic signal.
 * - `ContentDisclosureAiGeneratedDisclosure`: X's own automated/platform detection - a
 *   third-party classifier with an unknown false-positive rate, so it's rated lowest
 *   among the three known sources while still meaningfully above a bare flag.
 * - unknown/missing source (`hasAiGeneratedMedia` true but no recognized source string):
 *   the disclosure exists but its provenance can't be judged, so a conservative middle
 *   confidence is used.
 */
const CONFIDENCE_BY_DETECTION_SOURCE: Record<string, number> = {
  C2paClient: 1,
  UserDeclared: 0.9,
  ContentDisclosureAiGeneratedDisclosure: 0.75,
}
const UNKNOWN_SOURCE_CONFIDENCE = 0.6

/**
 * Resolves the confidence for one flagged tweet's detection source, falling back to
 * {@link UNKNOWN_SOURCE_CONFIDENCE} for an absent or unrecognized source string.
 * @param source - the tweet's `aiGeneratedDetectionSource`
 * @returns the confidence to attribute to this tweet's disclosure
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
