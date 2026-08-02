import type { LabelRule } from '../types'

// Both word orders are covered: "生成AI" ("generative AI") is the standard Japanese term
// order and at least as common as "AI生成" ("AI generation"), so a pattern covering only the
// AI-first order silently misses half the self-declarations.
const BIO_DECLARATION_PATTERN =
  /AI(で)?生成|生成AI|generated (by|using) AI|AI-generated|人工知能(で)?生成|created (by|with|using) AI/i

// The declaration pattern only checks that the term is present, not whether it is being
// denied, so a bio saying "一切AI生成はしません" ("I do not use AI generation at all") would
// otherwise be labelled true. Both sides of the match are inspected, and the window is wide
// enough to reach negations placed a few words away: prohibition markers (🚫/🈲/❌/NG) are
// frequently written before the term rather than after it.
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

// Bios that discuss generative AI as a professional subject (researcher, professor, media
// outlet, consultancy, business venture, regulation advocate) are talking about the field,
// not about the origin of their own posts. The institutional framing therefore vetoes the
// declaration - unless it is paired with an explicit personal-content phrase (e.g. "画像は" /
// "投稿しています") showing the account really is describing what it posts.
const INSTITUTIONAL_CONTEXT_PATTERN =
  /教授|研究者|代表取締役|\bCEO\b|公式(アカウント)?|メディア|事業|コンサル(ティング)?|規制派|反対派|賛成派|推進(派)?|アドバイザー|著書|委員|エンジニア|CAMP|ウェビナー|セミナー|活用ノウハウ|解説|考察|紹介します/i
const PERSONAL_CONTENT_DECLARATION_PATTERN =
  /画像は|イラストは|作品(です|を投稿)|ヘッダーは|アイコンは|投稿して(います|ます)|保管庫|ポートレート|-generated (images?|art|content|portraits?)|images? are AI/i

function isInstitutionalMention(bio: string): boolean {
  return INSTITUTIONAL_CONTEXT_PATTERN.test(bio) && !PERSONAL_CONTENT_DECLARATION_PATTERN.test(bio)
}

// The same "AI is a topic or tool I engage with, not the source of what I post" framing, in
// its non-professional variants: a hobby among several, a market sector followed as an
// investor, or - the largest single false-positive group - work-productivity phrasing from
// engineers and business-automation accounts ("生成AIで効率化", "生成AI・GAS で業務改善").
// Vetoed under the same personal-content condition as `isInstitutionalMention`.
const TOPIC_INTEREST_CONTEXT_PATTERN =
  /情報収集|実?活用|遊び|勉強中|興味|関心|ウォッチ|ウォチ|先端技術|追って|学ぼう|学ぶ|半導体|銘柄|効率化|業務改善|著作権問題/i

function isTopicInterestMention(bio: string): boolean {
  return TOPIC_INTEREST_CONTEXT_PATTERN.test(bio) && !PERSONAL_CONTENT_DECLARATION_PATTERN.test(bio)
}

// Accounts that OPPOSE generative AI - anti-AI activists, and hand-drawing artists
// forbidding others from training on their work - are the single largest false-positive
// group, and `isNegatedDeclaration` cannot catch them: it inspects a fixed window around
// only the FIRST match (so a closing 【生成AI不使用】 is never examined), and its vocabulary
// covers grammatical negation ("しません") rather than opposition ("反対", "嫌い", "認めません").
//
// This check scans the whole bio instead of a window, and is deliberately narrow so it does
// not swallow genuine AI creators, who very commonly forbid reposting or training in the
// same breath as declaring their own AI use. Two limits keep those out:
//   - a bare "学習禁止"/"転載禁止" is NOT treated as opposition, because both camps write it;
//   - the refusal word must sit close to the AI term, so a refusal aimed at a different
//     object further along the bio (e.g. a plain 無断転載 notice) does not veto.
const AI_OPPOSITION_PATTERN =
  /反生成AI|反AI生成|(?:生成AI|AI生成)(?:に|には)?反対|無断生成AI|(?:生成AI|AI生成).{0,15}(?:嫌い|きらい|認めません|認めない|ブロ(?:ック)?)|(?:生成AI|AI生成)(?:は)?(?:一切)?(?:不使用|使用していません|使っていません|使いません)|(?:生成AI|AI生成).{0,6}(?:お断り|お断わり)/i

// "〜している方" ("people who do ~") is a Japanese third-person construct: it describes a
// policy toward OTHER accounts (e.g. a follow-back refusal aimed at AI users), not a
// self-declaration of what this account posts. Vetoed the same way as institutional/topic
// mentions, unless paired with an explicit personal-content phrase.
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
