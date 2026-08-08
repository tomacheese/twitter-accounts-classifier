import type { LabelRule } from '../types'

// 曖昧な仄めかし表現まで対象にすると誤検知が増えるため、
// 年齢区分ラベルや直接的な自己申告語のみに意図的に絞り込んでいる。
// 英単語は無関係な語の内部に一致しないよう単語境界で判定している。
// 日本語の「アダルト」は \b が効かないため、
// NSFW とは無関係な心理学用語「アダルトチルドレン」を否定先読みで個別に除外している。
const NSFW_PATTERN = /\bNSFW\b|R-?18|18禁|成人向け|アダルト(?!チルドレン)|無修正/i

// NSFW 語を含みつつ実際には投稿しない/望まない旨を宣言するだけの bio は誤検知の主因となるため、
// これらに一致した場合はラベルを抑制している。
//
// DNI 表現による抑制は、
// NSFW 語と DNI が同一セグメント内で隣接している場合に限定している。
// 区切り文字や @ を挟む場合まで抑制対象にすると、
// DNI が未成年側を指す本来の NSFW アカウントの申告まで誤って抑制してしまうため。

// NSFW 語を用いつつも、話題として拒否している、
// 通報・ブロック対象として列挙している、
// あるいは別アカウントへ誘導しているだけの bio も同様に誤検知の原因となるため、
// 抑制対象に含めている。
const JP_REJECT_OR_REDIRECT_PATTERNS = [
  /(?:NSFW|R-?18|18禁|成人向け|アダルト|無修正)[^\n]{0,20}(?:受け付け(?:ません|ない)|お断り|禁止|NG|フォロー(?:は)?(?:しません|していません))/i,
  /(?:NSFW|R-?18|18禁|成人向け|アダルト|無修正)[^\n]{0,40}報告/i,
  /(?:NSFW|R-?18|18禁|成人向け|アダルト|無修正)(?:版)?→@/i,
]

const ANTI_NSFW_PATTERNS = [
  /(?:\bNSFW\b|\bR-?18\b)[^|｜@\n]{0,20}\bDNI\b/i,
  /\bDNI\b[^|｜@\n]{0,20}(?:\bNSFW\b|\bR-?18\b)/i,
  /\b(?:not|never)\b[^|｜\n]{0,20}\b(?:support|post|do|draw|share)\b[^|｜\n]{0,40}(?:\bNSFW\b|\bR-?18\b)/i,
  /(?:NSFW|R-?18|18禁|成人向け|アダルト)(?:の[^|｜\n]{0,6})?は[✖×✗❌]/i,
  ...JP_REJECT_OR_REDIRECT_PATTERNS,
]

export const topicNsfwRule: LabelRule = {
  key: 'topic_nsfw',
  description: 'プロフィールでアダルト/NSFW コンテンツを投稿していることを自己申告している',
  // 性的指向に関わる機微カテゴリであり、
  // フォローグラフからの推測だけで確定させることは避け、自己申告の bio のみを根拠とする。
  version: '1.4.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const optedOut = bio !== null && ANTI_NSFW_PATTERNS.some((pattern) => pattern.test(bio))
    const keywordMatch = bio !== null && NSFW_PATTERN.test(bio) && !optedOut
    return {
      value: keywordMatch,
      confidence: keywordMatch ? 0.8 : 0,
      reason: `bio nsfw-keyword match=${keywordMatch}`,
    }
  },
}
