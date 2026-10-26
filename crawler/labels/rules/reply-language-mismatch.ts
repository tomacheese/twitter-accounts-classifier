import { rampScore, toConfidence } from '../confidence'
import { stripUrlMentionAndRetweetPrefix } from '../text-similarity'
import type { LabelRule } from '../types'

// 完全な言語判定ではなく日本語スクリプト(ひらがな/カタカナ)の有無のみを判定する。
// 漢字を含めると中国語の投稿を日本語と誤認するため、仮名の有無で判定している。
// 既存のトピック系ルール群(topic_tech、topic_finance など)と同様、
// このプロジェクトが対象とするのは日本語 Twitter であるため。
const JAPANESE_SCRIPT_PATTERN = /[぀-ヿ]/

// 丸囲み文字や矢印・星などの装飾記号は Unicode 上も文字(Letter)ではなく記号(Symbol)に分類されるため、
// 絵文字を多用するが実際の文字を含む正当な非日本語投稿とは Letter の有無で区別できる。
const LETTER_PATTERN = /\p{L}/u

// ハッシュタグは本文の言語と無関係に作品名などの日本語を含みうるため、言語判定の対象から除く。
const HASHTAG_PATTERN = /[#＃][\p{L}\p{N}_]+/gu

function languageBody(text: string): string {
  return stripUrlMentionAndRetweetPrefix(text).replaceAll(HASHTAG_PATTERN, ' ')
}

// 装飾記号のみで構成される投稿は、日本語か否かに関わらず言語のシグナルを持たない空サンプルにすぎない。
function hasScriptContent(text: string): boolean {
  return LETTER_PATTERN.test(languageBody(text))
}

// 自分側の下限は返信側と揃え、評価不能を増やさない。
const MIN_OWN_POSTS = 3
const MIN_REPLIES = 3
const SCRIPT_MISMATCH_THRESHOLD = 0.7

// 会話の途中で他者の返信に応じる返信は、相手の言語に合わせる個別の対話であり、
// 無関係な読者への言語切り替えとは区別する。
// 会話のルートへの直接返信か、返信先が不明なものだけを不一致の根拠にする。
function isDialogueReply(t: {
  inReplyToTweetId?: string | null
  conversationId?: string | null
  parentTweetAuthorId?: string | null
}): boolean {
  return (
    t.inReplyToTweetId != null &&
    t.conversationId != null &&
    t.inReplyToTweetId !== t.conversationId &&
    t.parentTweetAuthorId != null
  )
}

function japaneseScriptRatio(texts: string[]): number {
  if (texts.length === 0) return 0
  return (
    texts.filter((text) => JAPANESE_SCRIPT_PATTERN.test(languageBody(text))).length / texts.length
  )
}

export const replyLanguageMismatchRule: LabelRule = {
  key: 'reply_language_mismatch',
  description:
    '自身のツイートは特定の言語体系にほぼ偏っているが、リプライ(自身のリプライを自己リツイートしているものを含む)では無関係な対象読者向けに突然言語が切り替わる(自分側の投稿が少ない場合と、会話途中の個別の対話は対象外)。エンゲージメント稼ぎボットネットワークの特徴',
  version: '1.7.0',
  evaluate(bundle) {
    const { screenName } = bundle.account
    // リンクのみの投稿はスクリプト比率が常に0になり、
    // 言語の「不一致」の根拠ではなく単に言語的内容を持たない空サンプルにすぎないため、
    // 比率の算出対象から除く。
    const ownPosts = bundle.recentTweets.filter(
      (t) => !t.isReply && !t.isRetweet && hasScriptContent(t.fullText),
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
        // 自分の投稿に寄せられたコメントへの返信は、相手の言語に合わせるのが自然なため対象から除く。
        t.conversationRootAuthorId !== bundle.account.id &&
        !isDialogueReply(t) &&
        hasScriptContent(t.fullText),
    )

    const hasEnoughSample = ownPosts.length >= MIN_OWN_POSTS && replies.length >= MIN_REPLIES
    const ownJapaneseRatio = japaneseScriptRatio(ownPosts.map((t) => t.fullText))
    const replyJapaneseRatio = japaneseScriptRatio(replies.map((t) => t.fullText))
    const mismatch = Math.abs(ownJapaneseRatio - replyJapaneseRatio)

    const value = hasEnoughSample && mismatch >= SCRIPT_MISMATCH_THRESHOLD
    // サンプル数が多いほど閾値超過分に対し早く 1.0 へ飽和するよう、
    // rampWidth をサンプルサイズの平方根に反比例させる (統計量そのものは smoothedRate 等で縮小しない)。
    const minSampleSide = Math.min(ownPosts.length, replies.length)
    const rampWidth = hasEnoughSample ? 0.3 * Math.sqrt(MIN_REPLIES / minSampleSide) : 0.3
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
