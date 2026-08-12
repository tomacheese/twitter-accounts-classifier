import { combineAlternatives, combineRequired, rampScore, toConfidence } from '../confidence'
import type { LabelRule } from '../types'

// 「フォロバ」「相互フォロー」「無言フォロー」「DMください」のような通常の礼儀表現は、
// ファンアカウントや懸賞アカウント、
// 公式ブランドアカウントを含む多くの正当な日本語アカウントで使われているため、
// あえて対象外とする。出会い系・裏垢 DM 販売・自動フォロー宣言・副業勧誘など、
// 明確に勧誘を示す文言のみを対象とする。
//
// 副業節の間隙は区切り記号・拒否記号を除外している。
// 副業 DM を拒否する bio は「副業」の直後に拒否マーカーを置くため、
// 無制限の間隙にするとその拒否をまたいで勧誘と誤認してしまうため。
const SOLICITATION_GAP = String.raw`[^\s❌🆖✗・、。!！🚫🈲]{0,10}`
const SOLICITATION_PATTERN = new RegExp(
  String.raw`出会い(系|活)|パパ活|ママ活|裏垢.{0,10}(dm|DM|募集|販売)|自動(フォロー|いいね)|稼げる|副業${SOLICITATION_GAP}(募集|紹介|稼)|儲かる|不労所得|高収入.{0,10}(バイト|副業)|f4f|follow\s*for\s*follow|dm\s*me.{0,10}fun`,
  'giu',
)

// SOLICITATION_PATTERN は用語の有無のみを判定し、
// bio がそれを拒否しているかは見ないため、
// 「出会い系はお断り」のような bio は拒否のために用語そのものを明記している。
// 一致箇所の直後の短い範囲を走査し、拒否マーカーがあれば勧誘とはみなさない。
// 実際の bio は丁寧・カジュアル・記号のみなど様々な距離・語調で拒否を書くため、
// 範囲は広めに、語彙も幅広く取っている。
// 拒否対象を複数列挙してから最後にまとめて拒否語を置く bio が多いため、
// window は列挙 1〜2 個分を見込める長さを確保している。
const REJECTION_WINDOW_LENGTH = 60
const REJECTION_PATTERN =
  /お断り|お断わり|御断り|拒否|NG|ダメ|禁止|お控え|ご遠慮|しないで|通報|ブロック|スルー|無視|要らん|要りません|要らない|いりません|いらない|不要|結構です|興味(が)?(あり|有り)?ません|対応(は)?していません|🆖|❌|✗/i

function isRejectedMatch(normalized: string, match: RegExpMatchArray): boolean {
  const index = match.index ?? 0
  const afterMatch = normalized.slice(
    index + match[0].length,
    index + match[0].length + REJECTION_WINDOW_LENGTH,
  )
  return REJECTION_PATTERN.test(afterMatch)
}

// 最初の一致だけを見ると、先に来た拒否表現につられて後方の別の勧誘を見逃す。
// そのため全ての一致箇所を判定し、いずれかが拒否文脈でなければ勧誘とみなす。
function hasGenuineSolicitation(bio: string): boolean {
  // 半角カタカナ・全角英数字などの表記ゆれを吸収するため、
  // 判定前に正規化する (例: 半角の「ﾀﾞﾒ」は全角「ダメ」の NG 語彙に一致しない)。
  const normalized = bio.normalize('NFKC')
  const matches = [...normalized.matchAll(SOLICITATION_PATTERN)]
  return matches.some((match) => !isRejectedMatch(normalized, match))
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
  version: '1.8.0',
  evaluate(bundle) {
    const { bio, followersCount, followingCount } = bundle.account
    const hasSolicitation = bio !== null && hasGenuineSolicitation(bio)

    const sampled = bundle.recentTweets
    const retweetRatio =
      sampled.length > 0 ? sampled.filter((t) => t.isRetweet).length / sampled.length : 0
    const hasBaitRetweetPattern = sampled.length >= 5 && retweetRatio >= 0.8

    const hasMassFollowingPattern = isMassFollowingPattern(followingCount, followersCount)

    const value = hasSolicitation && (hasBaitRetweetPattern || hasMassFollowingPattern)

    const retweetScore = rampScore(retweetRatio, 0.8, 0.2, 'higher-is-positive')
    const followingCountScore = rampScore(
      followingCount,
      MASS_FOLLOWING_MIN_COUNT,
      500,
      'higher-is-positive',
    )
    const followingRatio = followersCount > 0 ? followingCount / followersCount : followingCount
    const followingRatioScore = rampScore(
      followingRatio,
      MASS_FOLLOWING_RATIO,
      5,
      'higher-is-positive',
    )
    // hasSolicitation を combineRequired の一員に含めることで、
    // 勧誘が無い bio では他シグナルの強弱に関わらず evidenceScore を 0 に落とす。
    // 含めないと勧誘無しでも大量フォロー等の副シグナルだけで evidenceScore が高止まりし、
    // value=false の confidence が不当に低くなるため。
    const evidenceScore = combineRequired([
      hasSolicitation ? 1 : 0,
      combineAlternatives([
        retweetScore,
        combineRequired([followingCountScore, followingRatioScore]),
      ]),
    ])

    return {
      value,
      confidence: toConfidence(value, evidenceScore),
      reason: `bio solicitation=${hasSolicitation}, retweetRatio=${retweetRatio.toFixed(2)} (n=${sampled.length}), followingCount=${followingCount}, followersCount=${followersCount}`,
    }
  },
}
