import { rampScore, toConfidence } from '../confidence'
import type { LabelRule } from '../types'

// 完全な言語判定ではなく日本語スクリプト(ひらがな/カタカナ/漢字)の有無のみを判定する。
// 既存のトピック系ルール群(topic_tech、topic_finance など)と同様、
// このプロジェクトが対象とするのは日本語 Twitter であるため。
const JAPANESE_SCRIPT_PATTERN = /[぀-ヿ一-鿿]/

const MIN_SAMPLE_PER_SIDE = 3
const SCRIPT_MISMATCH_THRESHOLD = 0.7

function japaneseScriptRatio(texts: string[]): number {
  if (texts.length === 0) return 0
  return texts.filter((text) => JAPANESE_SCRIPT_PATTERN.test(text)).length / texts.length
}

// リンクのみのリプライは、言語に関わらずスクリプト比率が0になり、
// 言語の「不一致」の根拠ではなく、
// 単に言語的内容を持たない空サンプルにすぎない。
// URL・メンション・自己リツイートの接頭辞を除去し、
// 実質的なテキストが残っている場合のみ、どちらか一方の比率に算入する。
function hasLinguisticContent(text: string): boolean {
  const stripped = text
    .replace(/^RT @\w+:\s*/i, '')
    .replaceAll(/https?:\/\/\S+/gi, '')
    .replaceAll(/@\w+/g, '')
    .trim()
  return stripped.length > 0
}

export const replyLanguageMismatchRule: LabelRule = {
  key: 'reply_language_mismatch',
  description:
    '自身のツイートは特定の言語体系にほぼ偏っているが、リプライ(自身のリプライを自己リツイートしているものを含む)では無関係な対象読者向けに突然言語が切り替わる。エンゲージメント稼ぎボットネットワークの特徴',
  version: '1.3.0',
  evaluate(bundle) {
    const { screenName } = bundle.account
    const ownPosts = bundle.recentTweets.filter(
      (t) => !t.isReply && !t.isRetweet && hasLinguisticContent(t.fullText),
    )

    // 自身のスクリーンネームが引用元として表示される「リツイート」は、
    // 実質的には他者のコンテンツではなく、
    // 自身のリプライを自己拡散しているものである。
    //
    // 接頭辞の後に続く内容自体がリプライらしい形(`@メンション` で始まる)をしていることも要求する。
    // そうしないと、
    // 本文のないリンクのみの自己リツイート(例: `RT @foo: https://t.co/xxx`)にも一致してしまうため。
    // アカウント本来のリプライ言語に関わらずスクリプト比率が0と判定されてしまうため。
    const selfRetweetPrefix = `RT @${screenName}:`
    const isSelfRetweetedReply = (text: string): boolean =>
      text.startsWith(selfRetweetPrefix) &&
      text.slice(selfRetweetPrefix.length).trimStart().startsWith('@')
    const replies = bundle.recentTweets.filter(
      (t) =>
        (t.isReply || (t.isRetweet && isSelfRetweetedReply(t.fullText))) &&
        hasLinguisticContent(t.fullText),
    )

    const hasEnoughSample =
      ownPosts.length >= MIN_SAMPLE_PER_SIDE && replies.length >= MIN_SAMPLE_PER_SIDE
    const ownJapaneseRatio = japaneseScriptRatio(ownPosts.map((t) => t.fullText))
    const replyJapaneseRatio = japaneseScriptRatio(replies.map((t) => t.fullText))
    const mismatch = Math.abs(ownJapaneseRatio - replyJapaneseRatio)

    const value = hasEnoughSample && mismatch >= SCRIPT_MISMATCH_THRESHOLD
    // サンプル数が多いほど閾値超過分に対し早く 1.0 へ飽和するよう、
    // rampWidth をサンプルサイズに反比例させる (統計量そのものは smoothedRate 等で縮小しない)。
    const minSampleSide = Math.min(ownPosts.length, replies.length)
    const rampWidth = hasEnoughSample ? 0.3 * Math.sqrt(MIN_SAMPLE_PER_SIDE / minSampleSide) : 0.3
    const evidenceScore = hasEnoughSample
      ? rampScore(mismatch, SCRIPT_MISMATCH_THRESHOLD, rampWidth, 'higher-is-positive')
      : 0

    return {
      value,
      confidence: toConfidence(value, evidenceScore, hasEnoughSample),
      reason: `ownJapaneseRatio=${ownJapaneseRatio.toFixed(2)} (n=${ownPosts.length}), replyJapaneseRatio=${replyJapaneseRatio.toFixed(2)} (n=${replies.length})`,
      evaluable: hasEnoughSample,
    }
  },
}
