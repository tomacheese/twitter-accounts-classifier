/**
 * トレンド名の一覧を取得するスクレイパーの形。
 * `twitter-client`・`crawler` の双方が参照する共通インターフェースとして、
 * 実装 (`crawler/twitter/timeline.ts` が使う本体、`twitter-client` の trends クライアント) から独立させている。
 */
export interface TrendsScraperLike {
  getTrends(): Promise<string[]>
}
