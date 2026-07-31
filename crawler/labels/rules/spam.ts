import type { LabelRule } from '../types'

// Ordinary community-courtesy phrases ("フォロバ", "相互フォロー", "無言フォロー", "DMください")
// are used by a large share of genuine Japanese accounts - fan accounts, giveaway/懸賞 accounts,
// even official brand accounts - so they are deliberately excluded here. Only wording that
// indicates genuine solicitation is kept: dating/paid-companionship solicitation,
// secondary-account sales DMs, declared follow/like automation, and side-hustle bait.
//
// The gap inside the 副業 clause excludes separator/prohibition symbols: a bio refusing
// side-hustle DMs puts a refusal marker right after "副業", and an unrestricted gap would
// match straight across it and read the refusal as a solicitation.
const SOLICITATION_GAP = String.raw`[^\s❌🆖✗・、。!！🚫🈲]{0,10}`
const SOLICITATION_PATTERN = new RegExp(
  String.raw`出会い(系|活)|パパ活|ママ活|裏垢.{0,10}(dm|DM|募集|販売)|自動(フォロー|いいね)|稼げる|副業${SOLICITATION_GAP}(募集|紹介|稼)|儲かる|不労所得|高収入.{0,10}(バイト|副業)|f4f|follow\s*for\s*follow|dm\s*me.{0,10}fun`,
  'iu',
)

// SOLICITATION_PATTERN only checks that a term is present, not whether the bio is declining
// it - bios reading e.g. "出会い系はお断り" state the term precisely to refuse it. Scan a short
// window after the matched term for a refusal marker before treating the match as genuine
// solicitation. The window is generous and the vocabulary covers polite, casual/plain-form
// and symbol-only refusals, since real bios place the refusal at varying distance from the
// term and in widely varying registers.
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

// Spam bots mass-follow thousands of accounts hoping for reciprocal follows, so followingCount
// is HIGH relative to followersCount. The inverse shape (low following, high followers) belongs
// to prominent/official accounts and must not be flagged.
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
