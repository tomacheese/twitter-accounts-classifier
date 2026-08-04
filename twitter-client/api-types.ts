/**
 * トレンド名の一覧を取得するスクレイパーの形。
 * `twitter-client`・`crawler` の双方が参照する共通インターフェースとして、具体的な実装から独立させている。
 */
export interface TrendsScraperLike {
  getTrends(): Promise<string[]>
}
