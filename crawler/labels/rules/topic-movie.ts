import { combineAlternatives, toConfidence } from '../confidence'
import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// 英単語は他の topic_* ルールとの表記統一のため単語境界で判定しており、
// 日本語は単語境界の概念が同様には成り立たないため部分一致のままとしている。
const MOVIE_PATTERN =
  /\b(movie|movies|film|cinema|moviegoer|cinephile)\b|映画|ドラマ|洋画|邦画|映画館|映画鑑賞/i

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
  const before = bio.at(match.index - 1) ?? ''
  const after = bio.at(match.index + match[0].length) ?? ''
  return LIST_DELIMITER_CHARS.has(before) || LIST_DELIMITER_CHARS.has(after)
}

export const topicMovieRule: LabelRule = {
  key: 'topic_movie',
  description: 'プロフィールの直接証拠、またはフォロー関係から映画・ドラマとの強い関連が示される',
  version: '1.2.0',
  usesFollowGraphSignal: true,
  evaluate(bundle) {
    const { bio } = bundle.account
    const match = bio === null ? null : MOVIE_PATTERN.exec(bio)
    const keywordMatch = match !== null && !isSlashDelimitedTagListItem(bio ?? '', match)
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
