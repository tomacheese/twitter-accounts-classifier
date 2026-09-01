import { toConfidence } from '../confidence'
import type { LabelRule } from '../types'

// 「生成AI」と「AI生成」の両方の語順を含めているのは、
// AI 語順のみでは標準的な語順である「生成AI」の自己申告を見逃してしまうため。
const BIO_DECLARATION_PATTERN =
  /AI(で)?生成|生成AI|generated (by|using) AI|AI-generated|人工知能(で)?生成|created (by|with|using) AI/i

// 宣言パターンは用語の有無のみを判定し、否定表現を考慮しないため、
// 「一切AI生成はしません」のような否定を伴う bio を誤って true と判定してしまう。
// そのため一致箇所の前後双方を否定語で確認する。
// 禁止マーカー(🚫/🈲/❌/NG)は用語の後ろではなく前に書かれることが多いため、
// 確認範囲は前後に十分な幅を持たせている。
const NEGATION_WINDOW_LENGTH = 30
const NEGATION_PATTERN =
  /しません|していません|しておりません|おりません|しない|していない|ではありません|じゃありません|じゃない|不使用|未使用|不要|禁止|厳禁|やめて(ください)?|出来ません|できません|不可|盗用|盗作|盗品|🚫|🈲|❌|✖|\bNG\b|\bnot\b|\bnever\b|\bno\b/i

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

// 生成AIを研究者・教授・メディア・コンサル・事業として職業的に語る bio は、
// 自身の投稿の生成元ではなく、その分野について語っているにすぎないため、
// この職業的な文脈は宣言を無効化する。
// ただし「画像は」「投稿しています」のような自身のコンテンツを指す明示的な表現を伴う場合は、
// 実際に自己申告しているとみなす。
const INSTITUTIONAL_CONTEXT_PATTERN =
  /教授|研究者|代表取締役|\bCEO\b|公式(アカウント)?|メディア|事業|コンサル(ティング)?|規制派|反対派|賛成派|推進(派)?|アドバイザー|著書|委員|エンジニア|\bPdM\b|プロダクトマネージャー|プロダクトオーナー|プロダクト開発|CAMP|ウェビナー|セミナー|活用ノウハウ|解説|考察|紹介します|エバンジェリスト|evangelist|お仕事受付中|お仕事募集中|ジャーナリスト|記者|講師/i
// 「〜を紹介します」は INSTITUTIONAL_CONTEXT_PATTERN の職業的文脈語(メディア・解説等)としても
// 使われるが、「画像/イラスト/作品を紹介します」のように自身のコンテンツ名詞を目的語に取る場合は、
// 「画像は」のような主題化(は)ではなく目的語化(を)であっても、実質的に自己申告と同じである。
const PERSONAL_CONTENT_DECLARATION_PATTERN =
  /画像は|イラストは|作品(です|を投稿)|ヘッダーは|アイコンは|保管庫|ポートレート|(?:画像|イラスト|作品)を紹介(?:します|しています)|-generated (images?|art|content|portraits?)|images? are AI/i

// 「投稿して(います|ます)」は画像/イラストなどのコンテンツ名詞を伴わない限り、
// 単に何らかの記事を投稿している意味でしかなく、AI生成物の自己申告にはならない。
// そのため直前に自身のコンテンツを指す名詞が無い場合は自己申告とみなさない。
const CONTENT_NOUN_PATTERN = /画像|イラスト|作品|写真|アイコン|ヘッダー|ポートレート/
const CONTENT_POST_DECLARATION_WINDOW_LENGTH = 15

function isContentPostDeclaration(bio: string): boolean {
  const match = /投稿して(?:います|ます)/.exec(bio)
  if (match === null) return false
  const beforeMatch = bio.slice(
    Math.max(0, match.index - CONTENT_POST_DECLARATION_WINDOW_LENGTH),
    match.index,
  )
  return CONTENT_NOUN_PATTERN.test(beforeMatch)
}

function isPersonalContentDeclaration(bio: string): boolean {
  return PERSONAL_CONTENT_DECLARATION_PATTERN.test(bio) || isContentPostDeclaration(bio)
}

function isInstitutionalMention(bio: string): boolean {
  return INSTITUTIONAL_CONTEXT_PATTERN.test(bio) && !isPersonalContentDeclaration(bio)
}

// 職業的な文脈と同じ「AIは話題・関心事であり、
// 投稿の生成元ではない」という構図を、趣味・投資対象としての言及や、
// 業務効率化のための言及にも適用したもの。`isInstitutionalMention` と同様、
// 自身のコンテンツを指す明示的な表現を伴う場合のみ宣言として扱う。
const TOPIC_INTEREST_CONTEXT_PATTERN =
  /情報収集|実?活用|遊び|勉強中|興味|関心|ウォッチ|ウォチ|先端技術|追って|学ぼう|学ぶ|半導体|銘柄|効率化|業務改善|著作権問題|オタク|マニア/i

function isTopicInterestMention(bio: string): boolean {
  return TOPIC_INTEREST_CONTEXT_PATTERN.test(bio) && !isPersonalContentDeclaration(bio)
}

// 生成AIに反対するアカウント(アンチAI活動家や、
// 自作イラストへの学習を拒否する手描き作家)は最大の誤検知要因であり、
// `isNegatedDeclaration` では検出できない。
// 同関数は最初の一致箇所周辺の固定範囲のみを見るため、
// 文末の「【生成AI不使用】」のような表記を見逃すうえ、
// 語彙も文法的否定(「しません」)を対象としており、
// 「反対」「嫌い」「認めません」のような対立表現をカバーしていないため。
//
// 本チェックは bio 全体を走査するが、意図的に狭い語彙にとどめている。
// 生成AI利用者自身も、
// 自己申告と同じ文中で無断転載や無断学習を拒否することが非常に多く、
// それらを誤って対立表現とみなさないためである。
// 単なる「学習禁止」「転載禁止」は両陣営が書く表現であるため対立とはみなさず、
// 拒否語がAI用語から離れた場所(無関係な無断転載の注意書きなど)にある場合は無効化しない。
const AI_OPPOSITION_PATTERN =
  /反生成AI|反AI生成|(?:生成AI|AI生成)(?:に|には)?反対|無断生成AI|(?:生成AI|AI生成).{0,15}(?:嫌い|きらい|認めません|認めない|ブロ(?:ック)?|アンチ)|(?:生成AI|AI生成)(?:は)?(?:一切)?(?:不使用|使用していません|使っていません|使いません)|(?:生成AI|AI生成).{0,6}(?:お断り|お断わり)/i

// 「〜している方」は日本語における三人称の言い回しであり、
// 自身の投稿内容の自己申告ではなく、
// 他アカウントに対する方針(AI利用者へのフォロー拒否など)を述べているにすぎないため、
// 職業的・関心事の文脈と同様に無効化する。
// ただし自身のコンテンツを指す明示的な表現を伴う場合は例外とする。
const THIRD_PARTY_REFERENCE_PATTERN =
  /(?:生成AI|AI生成).{0,10}(?:して(?:る|いる)|使って(?:る|いる))方/

// 「生成AIアカウント」は「〜している方」と異なり、
// 自己申告(「生成AIアカウントです」)にも単独で使われる。
// そのため用語直後の一致だけで無効化すると、
// 自己申告を大量に誤って除外してしまう。
// DM/リプライ制限やお断りなど、他アカウントへの制約を示す語が近くにある場合に限り、
// 他アカウントへの方針を述べているとみなす。
const ACCOUNT_REFERENCE_PATTERN = /(?:生成AI|AI生成).{0,4}アカウント/
const ACCOUNT_RESTRICTION_WINDOW_LENGTH = 20
const ACCOUNT_RESTRICTION_CUE_PATTERN =
  /DM|リプ(?:ライ)?限定|お断り|お断わり|禁止|ブロック|フォロバ(?:しない|不可)?|遠慮/

function isAccountRestrictionMention(bio: string): boolean {
  const match = ACCOUNT_REFERENCE_PATTERN.exec(bio)
  if (match === null) return false
  const beforeMatch = bio.slice(
    Math.max(0, match.index - ACCOUNT_RESTRICTION_WINDOW_LENGTH),
    match.index,
  )
  const afterMatch = bio.slice(
    match.index + match[0].length,
    match.index + match[0].length + ACCOUNT_RESTRICTION_WINDOW_LENGTH,
  )
  return (
    ACCOUNT_RESTRICTION_CUE_PATTERN.test(beforeMatch) ||
    ACCOUNT_RESTRICTION_CUE_PATTERN.test(afterMatch)
  )
}

function isThirdPartyReference(bio: string): boolean {
  return (
    (THIRD_PARTY_REFERENCE_PATTERN.test(bio) || isAccountRestrictionMention(bio)) &&
    !isPersonalContentDeclaration(bio)
  )
}

// 「生成AIへの利用」「AI生成等への画像利用」は、生成AIを投稿手段ではなく
// 著作物の利用先・許諾対象として述べる文法であり、それ単独では自己申告ではない。
const AI_AS_USAGE_DESTINATION_PATTERN = /(?:生成AI|AI生成)(?:等)?への(?:画像)?(?:利用|使用)/gi
const AI_USAGE_OF_PATTERN = /(?:生成AI|AI生成)(?:等)?の(?:利用|使用)/gi
const USAGE_PERMISSION_CUE_WINDOW_LENGTH = 15
const USAGE_PERMISSION_CUE_PATTERN =
  /反対|禁止|お断り|お断わり|不可|大丈夫|\bNG\b|(?:^|[はも:=：／/、,\s])可(?:$|[。！!、,\s])/i
const AI_IMAGE_GENERATION_POST_PATTERN =
  /AI(?:画像|イラスト|作品|動画).{0,8}(?:を)?(?:生成|作成|制作).{0,8}(?:して)?投稿/i

function collectAiUsageTargetRanges(bio: string): [number, number][] {
  const ranges: [number, number][] = []

  AI_AS_USAGE_DESTINATION_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = AI_AS_USAGE_DESTINATION_PATTERN.exec(bio)) !== null) {
    ranges.push([match.index, match.index + match[0].length])
  }

  AI_USAGE_OF_PATTERN.lastIndex = 0
  while ((match = AI_USAGE_OF_PATTERN.exec(bio)) !== null) {
    const afterMatch = bio.slice(
      match.index + match[0].length,
      match.index + match[0].length + USAGE_PERMISSION_CUE_WINDOW_LENGTH,
    )
    if (USAGE_PERMISSION_CUE_PATTERN.test(afterMatch)) {
      ranges.push([match.index, match.index + match[0].length])
    }
  }

  return ranges
}

function isAiAsUsageTargetMention(bio: string): boolean {
  const ranges = collectAiUsageTargetRanges(bio)
  if (ranges.length === 0) return false

  let withoutUsageTargets = bio
  for (const [start, end] of ranges.toSorted((a, b) => b[0] - a[0])) {
    withoutUsageTargets = `${withoutUsageTargets.slice(0, start)}${' '.repeat(end - start)}${withoutUsageTargets.slice(end)}`
  }

  const hasIndependentSelfDeclaration =
    BIO_DECLARATION_PATTERN.test(withoutUsageTargets) ||
    AI_IMAGE_GENERATION_POST_PATTERN.test(withoutUsageTargets)
  return !hasIndependentSelfDeclaration
}

// 「/」「、」「,」やカッコなど、両側とも列挙の区切り文字に挟まれている用語は、
// 趣味・スキルの一覧の1項目として並べられているだけで、
// 自身のコンテンツの生成元を宣言しているわけではない。
// 前後どちらか一方だけの一致では通常の文中の読点なども誤って拾ってしまうため、
// 両側が区切りである場合に限定している。
const LIST_DELIMITER_CHARS = new Set(['/', '、', ',', '・', '|', '｜', '(', ')', '（', '）'])

function isListEnumerationItem(bio: string): boolean {
  const match = BIO_DECLARATION_PATTERN.exec(bio)
  if (match === null) return false
  const before = bio.slice(0, match.index).trimEnd()
  const after = bio.slice(match.index + match[0].length).trimStart()
  const beforeIsDelimiter = before.length === 0 || LIST_DELIMITER_CHARS.has(before.at(-1) ?? '')
  const afterIsDelimiter = after.length === 0 || LIST_DELIMITER_CHARS.has(after.at(0) ?? '')
  return beforeIsDelimiter && afterIsDelimiter && !isPersonalContentDeclaration(bio)
}

// AI_OPPOSITION_PATTERN は用語の直後に「反対」が続く定型文のみを対象としているため、
// 「反対しているもの」のような見出しの後に複数項目を並べ、
// その中に AI 語が含まれる bio を検出できない。
// 見出しは用語より前に来るため、直前の範囲だけを別途確認する。
const OPPOSITION_LIST_HEADER_PATTERN = /反対(?:して(?:いる|る))?(?:もの|こと)|嫌いなもの|苦手なもの/
const OPPOSITION_LIST_HEADER_WINDOW_LENGTH = 40

function isOppositionListHeader(bio: string): boolean {
  const match = BIO_DECLARATION_PATTERN.exec(bio)
  if (match === null) return false
  const beforeMatch = bio.slice(
    Math.max(0, match.index - OPPOSITION_LIST_HEADER_WINDOW_LENGTH),
    match.index,
  )
  return OPPOSITION_LIST_HEADER_PATTERN.test(beforeMatch)
}

const TWEET_BOILERPLATE_PATTERN = /as an AI language model|AIが生成|AI(が)?作成した/i

export const aiGeneratedRule: LabelRule = {
  key: 'ai-generated',
  description: 'プロフィールで AI 生成コンテンツを投稿していることを自己申告している',
  version: '1.10.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const hasDeclaration =
      bio !== null &&
      BIO_DECLARATION_PATTERN.test(bio) &&
      !isNegatedDeclaration(bio) &&
      !AI_OPPOSITION_PATTERN.test(bio) &&
      !isInstitutionalMention(bio) &&
      !isTopicInterestMention(bio) &&
      !isThirdPartyReference(bio) &&
      !isListEnumerationItem(bio) &&
      !isOppositionListHeader(bio) &&
      !isAiAsUsageTargetMention(bio)

    const sampled = bundle.recentTweets
    const hasCorroboratingTweet = sampled.some((t) => TWEET_BOILERPLATE_PATTERN.test(t.fullText))

    const value = hasDeclaration
    const evidenceScore = hasDeclaration ? (hasCorroboratingTweet ? 1 : 0.7) : 0

    return {
      value,
      confidence: toConfidence(value, evidenceScore),
      reason: `bio declaration=${hasDeclaration}, corroborating tweet=${hasCorroboratingTweet}`,
    }
  },
}
