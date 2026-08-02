import type { LabelRule } from '../types'

// 英単語は他の topic_* ルールとの表記統一のため単語境界で判定しており、
// 日本語は単語境界の概念が同様には成り立たないため部分一致のままとしている。
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
