export interface AccountFeatureBundle {
  account: {
    id: string
    screenName: string
    displayName: string
    bio: string | null
    followersCount: number
    followingCount: number
    tweetCount: number
    accountCreatedAt: Date
    isBlueVerified: boolean
    verifiedType: string | null
    /**
     * `user.professional?.professionalType` from the X API ('Business' | 'Creator').
     * Optional so bundles built by rule unit tests that predate this field keep
     * compiling unmodified.
     */
    professionalType?: string | null
    /**
     * `user.parodyCommentaryFanLabel` from the X API ('None' | 'Parody' | 'Commentary' |
     * 'Fan'). Optional for the same reason as `professionalType` above.
     */
    parodyCommentaryFanLabel?: string | null
  }
  recentTweets: {
    id: string
    fullText: string
    createdAt: Date
    retweetCount: number
    likeCount: number
    isReply: boolean
    isRetweet: boolean
    isPromoted: boolean
    isPaidPromotion: boolean
    /**
     * The tweet this one is a direct reply to, or `null`/absent if it isn't a reply or
     * the parent id is unknown. Optional so bundles built by rule unit tests that predate
     * this field keep compiling unmodified.
     */
    inReplyToTweetId?: string | null
    /**
     * Whether X's content-disclosure API flagged this tweet as containing AI-generated
     * media. `null` means this was never evaluated (either the tweet predates this column,
     * or the fetch path that observed it didn't carry the disclosure) - distinct from
     * `false`, which means a fetch positively confirmed no AI-generated media. Optional
     * for the same reason as `inReplyToTweetId` above.
     */
    hasAiGeneratedMedia?: boolean | null
    /**
     * How the AI-generated-media flag above was determined
     * (`'C2paClient' | 'ContentDisclosureAiGeneratedDisclosure' | 'UserDeclared'`), or
     * `null`/absent when `hasAiGeneratedMedia` is not `true`.
     */
    aiGeneratedDetectionSource?: string | null
    /**
     * The author id of the tweet this one quotes, or `null`/absent if it isn't a quote
     * tweet or the quoted tweet's author id is unknown. Optional so bundles built by rule
     * unit tests that predate this field keep compiling unmodified.
     */
    quotedTweetAuthorId?: string | null
    /**
     * Whether the quoted tweet's own media contains a video or animated GIF. Same
     * "unknown (`null`) vs. confirmed" convention as `hasAiGeneratedMedia` above - see
     * `prisma/schema.prisma`'s `Tweet.quotedTweetHasVideo` for detail. Optional for the
     * same reason as `quotedTweetAuthorId` above.
     */
    quotedTweetHasVideo?: boolean | null
  }[]
  /**
   * The largest number of distinct OTHER accounts observed posting a reply whose text
   * (after stripping URLs/mentions) exactly matches one of this account's own reply
   * tweets - a signature of templated, bulk-generated reply-bot networks. Computed once
   * per crawl/relabel run from a shared corpus (see `buildDuplicateReplyIndex`), not
   * per-rule, since a single rule only ever sees one account's bundle. Absent (treated
   * as 0) in bundles that don't populate it, e.g. most rules' own unit tests.
   */
  templatedReplyNetworkSize?: number
  /**
   * The size of the largest "reply-hijack swarm" this account has taken part in - a
   * group of 5+ distinct accounts (this one included) that each posted exactly one
   * paraphrased-similar reply to the same target tweet within a 24-hour window, farming
   * impressions off someone else's viral tweet. 0 (or absent) if none. Computed once per
   * crawl/relabel run from a shared corpus (see `buildReplyHijackIndex`), not per-rule -
   * same convention as `templatedReplyNetworkSize`.
   */
  replyHijackSwarmSize?: number
}

export interface LabelRuleResult {
  value: boolean
  /**
   * How much evidence supports the positive (`value: true`) case, roughly in the
   * `[0, 1]` range. `confidence` is only meaningful together with `value`: when `value`
   * is `false`, `confidence` may still be nonzero (individual rules may use it to reflect
   * partial/borderline signal strength even in the negative case). Do not treat
   * `confidence` as meaningful independent of `value` without checking `value` first.
   */
  confidence: number
  reason: string
}

export interface LabelRule {
  key: string
  description: string
  version: string
  evaluate(bundle: AccountFeatureBundle): LabelRuleResult
}
