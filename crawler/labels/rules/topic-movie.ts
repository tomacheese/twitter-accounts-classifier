import { combineAlternatives, toConfidence } from '../confidence'
import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// 英単語は他の topic_* ルールとの表記統一のため単語境界で判定しており、
// 日本語は単語境界の概念が同様には成り立たないため部分一致のままとしている。
// 「ドラマ」だけは「ドラマチック」「ドラマー (drummer)」という無関係な頻出語の
// 部分文字列になるため、topic-nsfw.ts の「アダルト」除外と同様に
// 否定先読みで個別に除外している。
// 「Cinema 4D (3DCG ソフト)」「film photographer (写真家)」も映画への関心ではないため同様に除外している。
const MOVIE_PATTERN =
  /\b(movie|movies|film(?!\s+photograph)|cinema(?!\s*4d\b)|moviegoer|cinephile)\b|映画|ドラマ(?!チック|ー)|洋画|邦画|映画館|映画鑑賞/gi

const KEYWORD_SCORE = 0.8

// 「Illust/Design/Movie」のような区切り文字付きタグ列挙は、
// 作品ジャンルのカテゴリラベルであり本人の映画への関心の自己申告ではない。
// 一方「映画、旅行、読書」のような読点区切りの趣味列挙は自己申告として扱いたいため、
// 区切り文字の種類で判別する: `/` `|` とその全角はタグ文化の bio で使われる区切りであり、
// 読点や通常の文中カンマとは性質が異なる。
const LIST_DELIMITER_PATTERN = /[/|／｜]/g
const LIST_DELIMITER_CHARS = new Set(['/', '|', '／', '｜'])
const MIN_LIST_DELIMITER_COUNT = 2

function isSlashDelimitedTagListItem(bio: string, match: RegExpExecArray): boolean {
  const delimiterCount = bio.match(LIST_DELIMITER_PATTERN)?.length ?? 0
  if (delimiterCount < MIN_LIST_DELIMITER_COUNT) return false
  // `String.prototype.at` は負のインデックスを末尾からの位置として扱うため、
  // match.index が0のときそのまま渡すと bio の末尾文字を誤って前方文字とみなしてしまう。
  const before = match.index > 0 ? (bio.at(match.index - 1) ?? '') : ''
  const after = bio.at(match.index + match[0].length) ?? ''
  return LIST_DELIMITER_CHARS.has(before) || LIST_DELIMITER_CHARS.has(after)
}

// 「〇〇脳」のように接尾語を直接結合したカンマ区切りの列挙(vibe list)は、
// 「映画、旅行、読書」のような趣味列挙とは異なり、雰囲気のラベル付けである。
// マッチ箇所の直後にこの種の接尾語が直接続き、
// かつ同種の接尾語パターンが bio 内に2回以上見られる場合のみ、この列挙とみなす。
// 単発であれば偶然の一致(「映画脳」で映画好きを自称する等)の可能性を排除できないため、
// 複数回の出現を要求する。
const VIBE_LIST_SUFFIXES = ['脳', 'ハート', 'スパイン', '系', '沼', '魂', '党', '民']
const VIBE_LIST_SUFFIX_AFTER_PATTERN = new RegExp(`^(?:${VIBE_LIST_SUFFIXES.join('|')})`)
const VIBE_LIST_SUFFIX_COUNT_PATTERN = new RegExp(
  `(?:${VIBE_LIST_SUFFIXES.join('|')})(?:[、,]|$)`,
  'g',
)
const MIN_VIBE_LIST_SUFFIX_COUNT = 2

function isVibeListItem(bio: string, match: RegExpExecArray): boolean {
  const after = bio.slice(match.index + match[0].length)
  if (!VIBE_LIST_SUFFIX_AFTER_PATTERN.test(after)) return false
  const suffixCount = bio.match(VIBE_LIST_SUFFIX_COUNT_PATTERN)?.length ?? 0
  return suffixCount >= MIN_VIBE_LIST_SUFFIX_COUNT
}

// 全角の＃も同じタグ列挙として扱わないと、全角表記だけ除外をすり抜ける。
const HASHTAG_PATTERN = /[#＃][^\s#＃]+/g

// テレビ番組ジャンルのタグ列挙に紛れた「ドラマ」は、映画への関心の自己申告ではない。
// 映画の語彙が別にあれば他の一致で陽性になるため、ドラマの一致だけを除外する。
const TV_PROGRAM_TAG_PATTERN = /バラエティ|お笑い|テレビ|番組|\bTV\b/i
const MIN_TV_PROGRAM_TAG_COUNT = 2

function isTvProgramTagListDrama(bio: string, match: RegExpExecArray): boolean {
  if (!match[0].includes('ドラマ')) return false
  const hashtags = [...bio.matchAll(HASHTAG_PATTERN)]
  const containing = hashtags.find(
    (hashtag) => match.index >= hashtag.index && match.index < hashtag.index + hashtag[0].length,
  )
  if (!containing) return false
  const tvTagCount = hashtags.filter(
    (hashtag) => hashtag !== containing && TV_PROGRAM_TAG_PATTERN.test(hashtag[0]),
  ).length
  return tvTagCount >= MIN_TV_PROGRAM_TAG_COUNT
}

function isHashtagListOnlyBio(bio: string, match: RegExpExecArray): boolean {
  const hashtags = [...bio.matchAll(HASHTAG_PATTERN)]
  if (hashtags.length < 3) return false
  const matchIsInHashtag = hashtags.some((hashtag) => {
    const start = hashtag.index
    return match.index >= start && match.index < start + hashtag[0].length
  })
  const prose = bio.replaceAll(HASHTAG_PATTERN, '').replaceAll(/[|,，、/・:：.。!！\-\s]/g, '')
  return matchIsInHashtag && prose.length === 0
}

// 最初の一致だけで除外判定すると、タグ列挙の後に続く本物の自己申告を見逃す。
// そのため、除外されない一致が1件でもあれば true とする。
function hasNonExcludedMovieMatch(bio: string): boolean {
  MOVIE_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MOVIE_PATTERN.exec(bio)) !== null) {
    if (
      !isSlashDelimitedTagListItem(bio, match) &&
      !isVibeListItem(bio, match) &&
      !isHashtagListOnlyBio(bio, match) &&
      !isTvProgramTagListDrama(bio, match)
    ) {
      return true
    }
  }
  return false
}

export const topicMovieRule: LabelRule = {
  key: 'topic_movie',
  description:
    'プロフィールの直接証拠、またはフォロー関係から映画・ドラマとの強い関連が示される。映画・ドラマ名がハッシュタグだけの列挙に現れる場合や、テレビ番組ジャンルのタグ列挙にドラマが 1 件だけ含まれる場合は直接証拠に含めない',
  version: '1.6.2',
  usesFollowGraphSignal: true,
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch = bio !== null && hasNonExcludedMovieMatch(bio)
    const followGraph = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_movie)
    const value = keywordMatch || followGraph.matched
    const evidenceScore = combineAlternatives([
      keywordMatch ? KEYWORD_SCORE : 0,
      followGraph.evidenceScore,
    ])
    const evaluable = bio !== null || followGraph.evaluable
    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      reason: `bio movie-keyword match=${keywordMatch}, follow-graph match=${followGraph.matched}`,
      evaluable,
    }
  },
}
