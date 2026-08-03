import type { LabelRule } from '../types'

// 「フォロバ」「相互フォロー」「無言フォロー」「DMください」のような通常のコミュニティ上の礼儀表現は、
// ファンアカウントや懸賞アカウント、
// 公式ブランドアカウントを含む多くの正当な日本語アカウントで使われているため、
// あえて対象外とする。出会い系・裏垢DM販売・自動フォロー宣言・副業勧誘など、
// 明確に勧誘を示す文言のみを対象とする。
//
// 副業節の間隙は区切り記号・拒否記号を除外している。
// 副業DMを拒否するbioは「副業」の直後に拒否マーカーを置くため、
// 無制限の間隙にするとその拒否をまたいで勧誘と誤認してしまうため。
const SOLICITATION_GAP = String.raw`[^\s❌🆖✗・、。!！🚫🈲]{0,10}`
const SOLICITATION_PATTERN = new RegExp(
  String.raw`出会い(系|活)|パパ活|ママ活|裏垢.{0,10}(dm|DM|募集|販売)|自動(フォロー|いいね)|稼げる|副業${SOLICITATION_GAP}(募集|紹介|稼)|儲かる|不労所得|高収入.{0,10}(バイト|副業)|f4f|follow\s*for\s*follow|dm\s*me.{0,10}fun`,
  'iu',
)

// SOLICITATION_PATTERN は用語の有無のみを判定し、
// bioがそれを拒否しているかは見ないため、
// 「出会い系はお断り」のようなbioは拒否のために用語そのものを明記している。
// 一致箇所の直後の短い範囲を走査し、拒否マーカーがあれば勧誘とはみなさない。
// 実際のbioは丁寧・カジュアル・記号のみなど様々な距離・語調で拒否を書くため、
// 範囲は広めに、語彙も幅広く取っている。
const REJECTION_WINDOW_LENGTH = 30
const REJECTION_PATTERN =
  /お断り|お断わり|御断り|NG|ダメ|禁止|お控え|ご遠慮|しないで|通報|ブロック|要らん|要りません|要らない|いりません|いらない|不要|結構です|興味(が)?(あり|有り)?ません|対応(は)?していません|🆖|❌|✗/i

function isRejectedSolicitation(bio: string): boolean {
  const match = SOLICITATION_PATTERN.exec(bio)
  if (match === null) return false
  const afterMatch = bio.slice(
    match.index + match[0].length,
    match.index + match[0].length + REJECTION_WINDOW_LENGTH,
  )
  return REJECTION_PATTERN.test(afterMatch)
}

// スパムボットはフォロー返しを期待して大量のアカウントをフォローするため、
// followingCount が followersCount に対して高くなる。
// 逆の形(フォロー少・フォロワー多)は著名・公式アカウントの特徴であり、
// 誤検知してはならない。
const MASS_FOLLOWING_MIN_COUNT = 500
const MASS_FOLLOWING_RATIO = 5

function isMassFollowingPattern(followingCount: number, followersCount: number): boolean {
  return (
    followingCount >= MASS_FOLLOWING_MIN_COUNT &&
    followingCount >= followersCount * MASS_FOLLOWING_RATIO
  )
}

export const spamRule: LabelRule = {
  key: 'spam',
  description:
    'プロフィールで出会い系/裏垢DM/自動フォローなどの勧誘・稼げる系文言があり、かつリツイート主体の釣り的なタイムライン、またはフォロー数がフォロワー数に比べて著しく多い大量フォロー傾向がある',
  version: '1.4.0',
  evaluate(bundle) {
    const { bio, followersCount, followingCount } = bundle.account
    const hasSolicitation =
      bio !== null && SOLICITATION_PATTERN.test(bio) && !isRejectedSolicitation(bio)

    const sampled = bundle.recentTweets
    const retweetRatio =
      sampled.length > 0 ? sampled.filter((t) => t.isRetweet).length / sampled.length : 0
    const hasBaitRetweetPattern = sampled.length >= 5 && retweetRatio >= 0.8

    const hasMassFollowingPattern = isMassFollowingPattern(followingCount, followersCount)

    let signals = 0
    if (hasSolicitation) signals += 1
    if (hasBaitRetweetPattern) signals += 1
    if (hasMassFollowingPattern) signals += 1

    const value = hasSolicitation && (hasBaitRetweetPattern || hasMassFollowingPattern)
    const confidence = signals === 0 ? 0 : signals / 3

    return {
      value,
      confidence,
      reason: `bio solicitation=${hasSolicitation}, retweetRatio=${retweetRatio.toFixed(2)} (n=${sampled.length}), followingCount=${followingCount}, followersCount=${followersCount}`,
    }
  },
}
