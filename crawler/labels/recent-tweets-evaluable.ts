import type { AccountFeatureBundle } from './types'

/**
 * `bundle.recentTweets` に依存するルールが、その結果を意味のある判定として扱ってよいかを返す。
 * `recentTweetsFetchStatus` が `'failed'`/`null` (未取得・取得失敗) の場合、
 * `recentTweets` が空でも「証拠が無い」ではなく「判定材料が無い」ため false を返す。
 * この項目を持たない bundle (多くのルール単体テストなど) は取得済みとして扱う。
 * @param bundle - 判定対象の feature bundle
 * @returns `recentTweets` に基づく判定を行ってよい場合 true
 */
export function isRecentTweetsEvaluable(bundle: AccountFeatureBundle): boolean {
  const fetchStatus = bundle.account.recentTweetsFetchStatus
  return fetchStatus === undefined || fetchStatus === 'success'
}
