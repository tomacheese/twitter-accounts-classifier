import type { LabelRule } from '../types'

// English terms are word-boundary-matched to avoid matching inside unrelated words
// (e.g. "cinema" would not collide with anything common, but keeping the same convention
// as the other topic_* rules for consistency). Japanese terms are left as substring matches
// since word boundaries don't apply the same way to Japanese script.
const MOVIE_PATTERN =
  /\b(movie|movies|film|cinema|moviegoer|cinephile)\b|映画|ドラマ|洋画|邦画|映画館|映画鑑賞/i

export const topicMovieRule: LabelRule = {
  key: 'topic_movie',
  description: 'プロフィールで映画・ドラマ鑑賞を中心的な関心事として挙げている',
  version: '1.0.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const value = bio !== null && MOVIE_PATTERN.test(bio)
    return {
      value,
      confidence: value ? 0.8 : 0,
      reason: `bio movie-keyword match=${value}`,
    }
  },
}
