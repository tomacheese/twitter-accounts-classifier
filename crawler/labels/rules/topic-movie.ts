import { combineAlternatives, toConfidence } from '../confidence'
import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// 英単語は他の topic_* ルールとの表記統一のため単語境界で判定しており、
// 日本語は単語境界の概念が同様には成り立たないため部分一致のままとしている。
// 「ドラマ」だけは「ドラマチック」という無関係な頻出語の部分文字列になるため、
// topic-nsfw.ts の「アダルト」除外と同様に否定先読みで個別に除外している。
const MOVIE_PATTERN =
  /\b(movie|movies|film|cinema|moviegoer|cinephile)\b|映画|ドラマ(?!チック)|洋画|邦画|映画館|映画鑑賞/i

const KEYWORD_SCORE = 0.8

// 「Illust/Design/Movie」のような区切り文字付きタグ列挙は、
// 作品ジャンルのカテゴリラベルであり本人の映画への関心の自己申告ではない。
// 一方「映画、旅行、読書」のような読点区切りの趣味列挙は自己申告として扱いたいため、
// 区切り文字の種類で判別する: `/` `|` はタグ文化の bio で使われる区切りであり、
// 読点や通常の文中カンマとは性質が異なる。
const LIST_DELIMITER_PATTERN = /[/|]/g
const LIST_DELIMITER_CHARS = new Set(['/', '|'])
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

export const topicMovieRule: LabelRule = {
  key: 'topic_movie',
  description: 'プロフィールの直接証拠、またはフォロー関係から映画・ドラマとの強い関連が示される',
  version: '1.4.0',
  usesFollowGraphSignal: true,
  evaluate(bundle) {
    const { bio } = bundle.account
    const match = bio === null ? null : MOVIE_PATTERN.exec(bio)
    const keywordMatch =
      match !== null &&
      !isSlashDelimitedTagListItem(bio ?? '', match) &&
      !isVibeListItem(bio ?? '', match)
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
