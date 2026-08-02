export const CRAWL_LIMITS = {
  // アルゴリズムによる「おすすめ」タイムラインを狭い範囲でしか取得しないと、
  // 同じフィードで人が見ているツイートを取りこぼし、手動クロールでなければ
  // 救えなくなるため、取得件数を広めに設定している。
  tweetsPerTimeline: 100,
  // 返信は1ツイートあたり深く、各アカウントの上位ツイートも広く取得しないと、
  // ルールが求める返信件数をアカウントごとに十分集められないため、多めに設定している。
  repliesPerTweet: 30,
  recentTweetsPerAccount: 20,
  topTweetsForReplies: 30,
  trendsPerCycle: 5,
  // 方向 (フォロー/フォロワー)・ログインアカウント・サイクルごとの件数。
  // 初期値であり、設定済みログインアカウントのフォロー/フォロワー数の実態次第では
  // 見直しが必要になる。
  followEdgesPerAccount: 2000,
  // アカウント単位のプロフィール・ツイート取得ループ (crawl.ts の runAccountCycleBody)
  // で、著者ごとに一時停止するミリ秒数。ペーシングなしでは単一ログインアカウントに
  // 多数のリクエストが集中し、レート制限や接続エラーが増えやすくなるため、
  // 固定の小休止でリクエスト頻度を平準化している。呼び出し単位のリトライは
  // twitter/retry.ts 側で別途扱う。
  authorFetchDelayMs: 300,
} as const

export const TWITTER_RETRY = {
  maxAttempts: 3,
  delayMs: 1000,
} as const
