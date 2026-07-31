export const CRAWL_LIMITS = {
  // A narrower snapshot of the algorithmic "recommended" timeline was observed to miss
  // tweets a human saw live in the same feed, recoverable only via a manual crawl - a
  // wider per-cycle sample reduces how much of that feed goes unseen.
  tweetsPerTimeline: 100,
  // ad_reply_hijack candidates need a deep reply sample per tweet, and a wide slice of
  // each account's own top tweets, to have any chance of accumulating the >=3 replies the
  // rule requires per account.
  repliesPerTweet: 30,
  recentTweetsPerAccount: 20,
  topTweetsForReplies: 30,
  trendsPerCycle: 5,
  // Per direction (following/followers), per login account, per cycle. Initial default -
  // revisit if observed follow/follower counts of the configured login accounts warrant a
  // different value.
  followEdgesPerAccount: 2000,
  // Milliseconds paused between each author in the per-author profile/tweet-fetch loop
  // (runAccountCycleBody in crawl.ts). The sample sizes above put many authors and many
  // per-author fetches through a single login account each cycle, which without pacing
  // correlated with more transient rate-limit/connection failures. A small fixed pause
  // smooths the request rate against that account's rate limit window; see
  // twitter/retry.ts for the complementary per-call retry.
  authorFetchDelayMs: 300,
} as const

export const TWITTER_RETRY = {
  maxAttempts: 3,
  delayMs: 1000,
} as const
