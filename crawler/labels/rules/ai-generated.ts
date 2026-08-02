import type { LabelRule } from '../types'

// 「生成AI」と「AI生成」の両方の語順を含めているのは、AI 語順のみでは
// 標準的な語順である「生成AI」の自己申告を見逃してしまうため。
const BIO_DECLARATION_PATTERN =
  /AI(で)?生成|生成AI|generated (by|using) AI|AI-generated|人工知能(で)?生成|created (by|with|using) AI/i

// 宣言パターンは用語の有無のみを判定し、否定表現を考慮しないため、
// 「一切AI生成はしません」のような否定を伴うbioを誤って true と判定してしまう。
// そのため一致箇所の前後双方を否定語で確認する。禁止マーカー(🚫/🈲/❌/NG)は
// 用語の後ろではなく前に書かれることが多いため、確認範囲は前後に十分な幅を持たせている。
const NEGATION_WINDOW_LENGTH = 25
const NEGATION_PATTERN =
  /しません|していません|しない|していない|ではありません|じゃありません|じゃない|不使用|未使用|禁止|厳禁|やめて(ください)?|出来ません|できません|不可|盗用|盗作|盗品|🚫|🈲|❌|\bNG\b|\bnot\b|\bnever\b|\bno\b/i

function isNegatedDeclaration(bio: string): boolean {
  const match = BIO_DECLARATION_PATTERN.exec(bio)
  if (match === null) return false
  const beforeMatch = bio.slice(Math.max(0, match.index - NEGATION_WINDOW_LENGTH), match.index)
  const afterMatch = bio.slice(
    match.index + match[0].length,
    match.index + match[0].length + NEGATION_WINDOW_LENGTH,
  )
  return NEGATION_PATTERN.test(beforeMatch) || NEGATION_PATTERN.test(afterMatch)
}

// 生成AIを研究者・教授・メディア・コンサル・事業として職業的に語るbioは、
// 自身の投稿の生成元ではなく、その分野について語っているにすぎないため、
// この職業的な文脈は宣言を無効化する。ただし「画像は」「投稿しています」のような
// 自身のコンテンツを指す明示的な表現を伴う場合は、実際に自己申告しているとみなす。
const INSTITUTIONAL_CONTEXT_PATTERN =
  /教授|研究者|代表取締役|\bCEO\b|公式(アカウント)?|メディア|事業|コンサル(ティング)?|規制派|反対派|賛成派|推進(派)?|アドバイザー|著書|委員|エンジニア|CAMP|ウェビナー|セミナー|活用ノウハウ|解説|考察|紹介します/i
const PERSONAL_CONTENT_DECLARATION_PATTERN =
  /画像は|イラストは|作品(です|を投稿)|ヘッダーは|アイコンは|投稿して(います|ます)|保管庫|ポートレート|-generated (images?|art|content|portraits?)|images? are AI/i

function isInstitutionalMention(bio: string): boolean {
  return INSTITUTIONAL_CONTEXT_PATTERN.test(bio) && !PERSONAL_CONTENT_DECLARATION_PATTERN.test(bio)
}

// 職業的な文脈と同じ「AIは話題・関心事であり、投稿の生成元ではない」という構図を、
// 趣味・投資対象としての言及や、業務効率化のための言及にも適用したもの。
// `isInstitutionalMention` と同様、自身のコンテンツを指す明示的な表現を伴う場合のみ
// 宣言として扱う。
const TOPIC_INTEREST_CONTEXT_PATTERN =
  /情報収集|実?活用|遊び|勉強中|興味|関心|ウォッチ|ウォチ|先端技術|追って|学ぼう|学ぶ|半導体|銘柄|効率化|業務改善|著作権問題/i

function isTopicInterestMention(bio: string): boolean {
  return TOPIC_INTEREST_CONTEXT_PATTERN.test(bio) && !PERSONAL_CONTENT_DECLARATION_PATTERN.test(bio)
}

// 生成AIに反対するアカウント(アンチAI活動家や、自作イラストへの学習を拒否する
// 手描き作家)は最大の誤検知要因であり、`isNegatedDeclaration` では検出できない。
// 同関数は最初の一致箇所周辺の固定範囲のみを見るため、文末の「【生成AI不使用】」のような
// 表記を見逃すうえ、語彙も文法的否定(「しません」)を対象としており、
// 「反対」「嫌い」「認めません」のような対立表現をカバーしていないため。
//
// 本チェックはbio全体を走査するが、意図的に狭い語彙にとどめている。生成AI利用者自身も、
// 自己申告と同じ文中で無断転載や無断学習を拒否することが非常に多く、それらを誤って
// 対立表現とみなさないためである。単なる「学習禁止」「転載禁止」は両陣営が書く表現であるため
// 対立とはみなさず、拒否語がAI用語から離れた場所(無関係な無断転載の注意書きなど)にある
// 場合は無効化しない。
const AI_OPPOSITION_PATTERN =
  /反生成AI|反AI生成|(?:生成AI|AI生成)(?:に|には)?反対|無断生成AI|(?:生成AI|AI生成).{0,15}(?:嫌い|きらい|認めません|認めない|ブロ(?:ック)?)|(?:生成AI|AI生成)(?:は)?(?:一切)?(?:不使用|使用していません|使っていません|使いません)|(?:生成AI|AI生成).{0,6}(?:お断り|お断わり)/i

// 「〜している方」は日本語における三人称の言い回しであり、自身の投稿内容の自己申告ではなく、
// 他アカウントに対する方針(AI利用者へのフォロー拒否など)を述べているにすぎないため、
// 職業的・関心事の文脈と同様に無効化する。ただし自身のコンテンツを指す
// 明示的な表現を伴う場合は例外とする。
const THIRD_PARTY_REFERENCE_PATTERN =
  /(?:生成AI|AI生成).{0,10}(?:して(?:る|いる)|使って(?:る|いる))方/

function isThirdPartyReference(bio: string): boolean {
  return THIRD_PARTY_REFERENCE_PATTERN.test(bio) && !PERSONAL_CONTENT_DECLARATION_PATTERN.test(bio)
}

const TWEET_BOILERPLATE_PATTERN = /as an AI language model|AIが生成|AI(が)?作成した/i

export const aiGeneratedRule: LabelRule = {
  key: 'ai-generated',
  description: 'プロフィールで AI 生成コンテンツを投稿していることを自己申告している',
  version: '1.7.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const hasDeclaration =
      bio !== null &&
      BIO_DECLARATION_PATTERN.test(bio) &&
      !isNegatedDeclaration(bio) &&
      !AI_OPPOSITION_PATTERN.test(bio) &&
      !isInstitutionalMention(bio) &&
      !isTopicInterestMention(bio) &&
      !isThirdPartyReference(bio)

    const sampled = bundle.recentTweets
    const hasCorroboratingTweet = sampled.some((t) => TWEET_BOILERPLATE_PATTERN.test(t.fullText))

    const value = hasDeclaration
    const confidence = hasDeclaration ? (hasCorroboratingTweet ? 1 : 0.7) : 0

    return {
      value,
      confidence,
      reason: `bio declaration=${hasDeclaration}, corroborating tweet=${hasCorroboratingTweet}`,
    }
  },
}
