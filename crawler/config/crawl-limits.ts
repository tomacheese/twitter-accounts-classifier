export const CRAWL_LIMITS = {
  // アルゴリズムによる「おすすめ」タイムラインを狭い範囲でしか取得しないと、
  // 同じフィードで人が見ているツイートを取りこぼし、
  // 手動クロールでなければ救えなくなるため、取得件数を広めに設定している。
  tweetsPerTimeline: 100,
  // 返信は1ツイートあたり深く、各アカウントの上位ツイートも広く取得しないと、
  // ルールが求める返信件数をアカウントごとに十分集められないため、
  // 多めに設定している。
  repliesPerTweet: 30,
  recentTweetsPerAccount: 20,
  topTweetsForReplies: 30,
  trendsPerCycle: 5,
  // 方向 (フォロー/フォロワー)・ログインアカウント・サイクルごとの件数。
  // 初期値であり、
  // 設定済みログインアカウントのフォロー/フォロワー数の実態次第では見直しが必要になる。
  followEdgesPerAccount: 2000,
  // ブロック一覧は本人のものしか取得できず、followEdgesPerAccount とは傾向が異なりうるため独立した定数にする。
  blockEdgesPerAccount: 2000,
  // ラベリング対象アカウント自身のフォロー先サンプリング用。
  // fetchFollowing のページサイズ (200) と同値にし、
  // 必ず1ページ・1リクエストで完結させる。
  followEdgesPerLabeledAccount: 200,
  // ペーシングなしでは単一ログインアカウントに多数のリクエストが集中し、レート制限や接続エラーが増えやすくなるため、固定の小休止でリクエスト頻度を平準化している。
  authorFetchDelayMs: 300,
} as const

export const TWITTER_RETRY = {
  maxAttempts: 3,
  delayMs: 1000,
} as const

export const SELF_REPLY_PROMO_CHAIN_LIMITS = {
  // TweetDetail は focal tweet 直下の子ノードまでしか返さないため、
  // depth 2 以降は self-reply 自身を focalTweetId として再帰的に呼び出す必要がある。
  // この深さ・件数の上限は初期値であり、backtest 結果を見て調整する想定の設定値である。
  maxDepth: 6,
  maxNodesPerRoot: 8,
  // self-promo の追加反映が遅れて観測されることがあるため、余裕を持たせた初期値である。
  candidateMinAgeHours: 24,
  candidateProbeCount: 3,
} as const
