import { toConfidence } from '../confidence'
import type { LabelRule } from '../types'

// 曖昧な仄めかし表現まで対象にすると誤検知が増えるため、
// 年齢区分ラベルや直接的な自己申告語のみに意図的に絞り込んでいる。
// 英単語は無関係な語の内部に一致しないよう単語境界で判定している。
// 日本語の「アダルト」は \b が効かないため、
// NSFW とは無関係な心理学用語「アダルトチルドレン」を否定先読みで個別に除外している。
// 格闘ゲームの MR (マスターレート) 表記や型番のような「XR18」表記は
// 「R18」を部分文字列として含んでしまうため、直前が英字の場合は除外している。
const NSFW_PATTERN =
  /\bNSFW\b|(?<![A-Za-z])R-?18(?!\d)|(?<!\d)18禁(?!煙)|成人向け(?!英会話|プログラミング|教育)|アダルト(?!チルドレン|ラバッパー)|無修正(?!の?写真(?!集))/i

// NSFW 語を含みつつ実際には投稿しない/望まない旨を宣言するだけの bio は誤検知の主因となるため、
// これらに一致した場合はラベルを抑制している。
//
// DNI 表現による抑制は、NSFW 語と DNI が隣り合う場合に限定している。
// 語を挟んだ「NSFW artist, minors DNI」のように DNI が未成年側を指す形は、
// 本来の NSFW アカウントの申告なので抑制してはならない。
// 逆順も同様で、読点で区切られた「minors DNI, NSFW artist」は抑制せず、
// 「DNI: nsfw accounts」のようにコロンや空白で直結する列挙だけを対象にしている。

// NSFW 語を用いつつも、話題として拒否している、
// 通報・ブロック対象として列挙している、
// あるいは別アカウントへ誘導しているだけの bio も同様に誤検知の原因となるため、
// 抑制対象に含めている。
// 別アカウントへの誘導は URL がなく @ ハンドルだけの形も多いため、@ 直結の形も対象にしている。
// 否定は「しません」「なし」「非」など短い距離の直接的な否定語に限り、
// 離れた位置の「ありません」まで拾うと真正な申告を抑制してしまう。
// 「NG」は英単語の内部 (drawing など) に一致しないよう英字の隣接を除外している。
const JP_REJECT_OR_REDIRECT_PATTERNS = [
  /(?:NSFW|R-?18|18禁|成人向け|アダルト|無修正)(?:(?!未成年|18歳未満|高校生)[^\n。]){0,20}(?:受け付け(?:ません|ない)|お断り|拒否|厳禁|(?<![A-Za-z])NG(?![A-Za-z])|フォロ(?:ー|バ)(?:は)?(?:しません|していません))/i,
  /(?:NSFW|R-?18G?|18禁|成人向け|アダルト|無修正)[^\n。]{0,20}(?:即ブロック|ブロ(?![ッグ]))/i,
  /(?:NSFW|R-?18G?|18禁|成人向け|アダルト|無修正)\s*(?:系|関連)?の?(?:アカウント|垢|投稿|ツイート|画像|作品|絵|DM|リプ|リプライ|フォロー|閲覧|方|話題|話|内容|コンテンツ)?[はもをの]?(?:嫌なので|全部|全て|すべて)?(?:禁止(?!\s*[（(]?\s*(?:未成年|18歳未満))|ブロック)/i,
  /(?:NSFW|R-?18|18禁|成人向け|アダルト|無修正)(?:(?!描|依頼|フォロー|リプ|DM|ご|投稿|公開|掲載)[^\n。、]){0,12}(?:もらう|もらい|貰|頂|いただ)/i,
  /(?:NSFW|R-?18|18禁|成人向け|アダルト|無修正)(?:版|垢|アカウント)?[はも]?\s*[→➡⇒▶:：]\s*(?:https?:\/\/|(?:x|twitter)\.com\/)/i,
  /(?:NSFW|R-?18|18禁|成人向け|アダルト|無修正).{0,8}(?:垢|アカウント|account|sub)[:：]?\s*(?:https?:\/\/)?(?:x|twitter)\.com\//i,
  /(?:NSFW|R-?18|18禁|成人向け|アダルト|無修正)[^\n。]{0,40}報告(?:します|して|対象|の対象|する)/i,
  /(?:NSFW|R-?18|18禁|成人向け|アダルト|無修正)[^\n→]{0,12}→@/i,
  /(?:NSFW|R-?18|18禁|成人向け|アダルト|無修正).{0,8}(?:垢|アカ|アカウント|alt|account|sub)[ \u3000]{0,2}[:：]?[ \u3000]{0,2}@/i,
  /(?:NSFW|R-?18|18禁|成人向け|アダルト|無修正)[^\n。]{0,8}(?:しません|してません|していません|ありません|(?<!固定)なし|(?<!固定)無し|見ません|描きません|読みません|苦手(?:です|なので)|ご遠慮)/i,
  /(?:NSFW|R-?18|18禁|成人向け|アダルト|無修正)[^\n]{0,16}(?:X|Twitter|ツイッター)内?には?(?:ありません|ない)/i,
  /(?:非|\b(?:non|not|no)[\s-]+(?:(?:[a-z]{2,3}|spam)\/)*)(?:NSFW|R-?18|18禁|成人向け|アダルト|無修正)/i,
  /(?:NSFW|R-?18|18禁|成人向け|アダルト|無修正).{0,24}(?:別垢|別アカウント|詳しくは|続きは|こちら).{0,32}(?:https?:\/\/|URL|リンク)/i,
  /(?:NSFW|R-?18|18禁|成人向け|アダルト|無修正).{0,8}(?:垢|アカウント|account|sub).{0,12}→?.{0,24}(?:https?:\/\/|URL|リンク)/i,
  /(?:NSFW|R-?18|18禁|成人向け|アダルト|無修正).{0,8}(?:垢|アカウント|account|sub)[:：]?\s*@/i,
  /(?:NSFW|R-?18|18禁|成人向け|アダルト|無修正)[^\n@]{0,10}投稿用(?:[（(][^）)\n]{0,40}[）)])?[→:：]?\s*@/i,
  /(?:NSFW|R-?18|18禁)は?(?:[（(]|[弟妹兄姉垢別用])@/i,
  /(?:NSFW|R-?18|18禁)は別垢/i,
  /@[A-Za-z0-9_]{1,15}[（(]※?\s*(?:NSFW|R-?18)/i,
  /(?:NSFW|R-?18|18禁)[^\n。]{0,12}は\s?(?:pixiv|ピクシブ|fanbox|fantia)/i,
  /(?:アダルト|成人向け)系?[^\n。]{0,40}興味(?:は)?(?:ありません|ない|なし)/i,
  /(?:NSFW|R-?18|18禁|成人向け|アダルト|無修正)は[^\n]{0,12}(?:pixiv|ピクシブ|fanbox|fantia|サブ|別|垢)[^\n]{0,8}にて/i,
  /@[A-Za-z0-9_]*(?:NSFW|R-?18)[A-Za-z0-9_]*/i,
  /(?:NSFW|R-?18)\s+(?:works?|art|arts|content|pics?|images?|drawings?)\s*[→:：]?\s*[@＠][A-Za-z0-9_]/i,
  /[@＠][A-Za-z0-9_]+\s*[（(](?:NSFW|R-?18)[）)]/i,
  /(?:NSFW|R-?18|18禁)[^\n]{0,40}担当絵師/i,
  /(?:NSFW|R-?18|18禁)[ \u3000]{1,2}https?:\/\//i,
  /[（(]R-?18[）)]\s*(?:\(a\)|[@＠])/i,
  /(?:初|プレイ|やって|遊)[^\n]{0,4}18禁ゲー/i,
  /(?:アダルト|成人向け)[^\n]{0,8}見放題/i,
  /(?:NSFW|R-?18|18禁|成人向け|アダルト|無修正)[^\n]{0,60}(?:サブアカウント|サブ垢|別アカウント|別垢)(?:にて|で)(?:のみ)?(?:対応|投稿|公開|運用)/i,
  /(?:NSFW|R-?18|18禁|成人向け|アダルト|無修正)[はも]?(?:苦手(?!な(?:方|人|かた))|ダメ|無理|嫌い)/i,
  /(?:NSFW|R-?18|18禁|成人向け|アダルト|無修正)(?:系|関係|関連)[^\n。]{0,25}(?:全く|一切)?興味(?:が)?(?:ありません|ない|なし)/i,
  /(?:NSFW|R-?18|18禁)\s*[/／]\s*[@＠]/i,
  /(?:アダルトグッズ|成人向け商品|大人向け商品).{0,16}(?:公式|販売|ショップ|事業)/i,
  /(?:公式|販売|ショップ|事業).{0,16}(?:アダルトグッズ|成人向け商品|大人向け商品)/i,
]

// 「全年齢から成人向けまで」のような対応範囲の提示は、投稿していることの一人称の申告ではないため抑制する。
const ANTI_NSFW_PATTERNS = [
  /(?:全年齢|一般向け)(?:向け)?\s*(?:から|[〜～~・/／]|と)\s*(?:NSFW|R-?18|18禁|成人向け|アダルト|無修正)/i,
  /(?:\bNSFW\b|\bR-?18\b)[\s,/・:：-]{0,3}(?:(?:accounts?|accts?|content|users?)\s{1,2})?\bDNI\b/i,
  /\bDNI\b[\s:：/・-]{0,3}(?:\bNSFW\b|\bR-?18\b)/i,
  /\b(?:not|never)\b[^|｜\n]{0,20}\b(?:support|post|do|draw|share)\b[^|｜\n]{0,40}(?:\bNSFW\b|\bR-?18\b)/i,
  /(?:NSFW|R-?18|18禁|成人向け|アダルト)(?:の[^|｜\n]{0,6})?は[✖×✗❌]/i,
  /(?:NSFW|R-?18|18禁|成人向け|アダルト)\s{0,2}[✖×✗❌]\uFE0F?(?![A-Za-z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/iu,
  /(?:アダルト|成人向け)[^\n。、]{0,12}を?(?:研究|分析|調査)(?!よりも)/i,
  ...JP_REJECT_OR_REDIRECT_PATTERNS,
]

interface MatchSpan {
  start: number
  end: number
}

/**
 * パターンに `g` フラグを付与した上で bio 全体に一致する箇所をすべて探し、その位置区間を返す。
 * @param pattern - 検索する正規表現 (`g` フラグの有無は問わない)
 * @param bio - 検索対象の bio 文字列
 * @returns 一致箇所ごとの開始・終了位置の配列
 */
function findAllMatchSpans(pattern: RegExp, bio: string): MatchSpan[] {
  const globalPattern = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  )
  return [...bio.matchAll(globalPattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }))
}

function overlaps(a: MatchSpan, b: MatchSpan): boolean {
  return a.start < b.end && b.start < a.end
}

export const topicNsfwRule: LabelRule = {
  key: 'topic_nsfw',
  description:
    'プロフィールでアダルト/NSFW コンテンツを投稿していることを自己申告している。別アカウントへの誘導 (URL 形式を含む)、他者から受け取る側の言及、成人向け商品の販売、「全年齢から成人向けまで」のような対応範囲の提示だけでは該当しない。NSFW 語を禁止・拒否の対象として宣言するだけの bio も該当しない',
  // 性的指向に関わる機微カテゴリであり、
  // フォローグラフからの推測だけで確定させることは避け、自己申告の bio のみを根拠とする。
  version: '1.14.1',
  evaluate(bundle) {
    const { bio } = bundle.account
    if (bio === null) {
      return {
        value: false,
        confidence: toConfidence(false, 0),
        reason: 'bio nsfw-keyword match=false',
      }
    }

    // 抑制パターンは、一致した NSFW 語の出現箇所と重なる場合のみ適用する。
    // bio 全体で抑制の有無だけを見ると、
    // 無関係な箇所の拒否表現が別の真正な自己申告まで抑制してしまうため。
    const nsfwSpans = findAllMatchSpans(NSFW_PATTERN, bio)
    const antiSpans = ANTI_NSFW_PATTERNS.flatMap((pattern) => findAllMatchSpans(pattern, bio))
    const keywordMatch = nsfwSpans.some(
      (span) => !antiSpans.some((antiSpan) => overlaps(span, antiSpan)),
    )
    return {
      value: keywordMatch,
      confidence: toConfidence(keywordMatch, keywordMatch ? 0.8 : 0),
      reason: `bio nsfw-keyword match=${keywordMatch}`,
    }
  },
}
