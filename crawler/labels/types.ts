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
     * X API の `user.professional?.professionalType`（'Business' | 'Creator'）に対応する値。
     * この項目が存在する前に作られたルール単体テストの bundle も無修正でコンパイルが通るよう、
     * 任意項目にする。
     */
    professionalType?: string | null
    /**
     * X API の `user.parodyCommentaryFanLabel`（'None' | 'Parody' | 'Commentary' | 'Fan'）に
     * 対応する値。任意項目にする理由は `professionalType` と同じ。
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
     * このツイートが直接リプライしている先のツイート ID。リプライでない場合、または
     * 親ツイート ID が不明な場合は `null`/未設定にする。任意項目にする理由は
     * `professionalType` と同じ。
     */
    inReplyToTweetId?: string | null
    /**
     * X のコンテンツ開示 API が、このツイートに AI 生成メディアが含まれると判定したか。
     * `null` は「一度も評価されていない」ことを表し（この列より前のツイート、または開示情報を
     * 持たない取得経路の場合）、「取得の結果 AI 生成メディアなしと確定した」ことを表す `false`
     * とは区別する。任意項目にする理由は `inReplyToTweetId` と同じ。
     */
    hasAiGeneratedMedia?: boolean | null
    /**
     * 上記の AI 生成メディアフラグをどう判定したか
     * （`'C2paClient' | 'ContentDisclosureAiGeneratedDisclosure' | 'UserDeclared'`）。
     * `hasAiGeneratedMedia` が `true` でない場合は `null`/未設定にする。
     */
    aiGeneratedDetectionSource?: string | null
    /**
     * X がこのツイートの投稿者以外を出典として示す添付動画の件数。過去の収集結果から
     * 作られた bundle との互換性を保つため optional にする。
     */
    foreignVideoSourceCount?: number | null
    /**
     * このツイートが引用しているツイートの投稿者 ID。引用ツイートでない場合、または
     * 引用先ツイートの投稿者 ID が不明な場合は `null`/未設定にする。任意項目にする理由は
     * `inReplyToTweetId` と同じ。
     */
    quotedTweetAuthorId?: string | null
    /**
     * 引用元ツイート自体のメディアに動画または GIF が含まれるか。「未確認 (`null`) か
     * 確定済みか」という区別は `hasAiGeneratedMedia` と同じ規約で、詳細は
     * `prisma/schema.prisma` の `Tweet.quotedTweetHasVideo` を参照。任意項目にする理由は
     * `quotedTweetAuthorId` と同じ。
     */
    quotedTweetHasVideo?: boolean | null
  }[]
  /**
   * URL・メンションを除去したうえで、この投稿者自身のいずれかのリプライ本文と完全一致する
   * リプライを投稿した、他アカウントの最大観測数。定型文を使い回す量産型リプライボット網の
   * 特徴を示す。ルールごとではなく、クロール/再ラベリング実行ごとに共有コーパスから一度だけ
   * 算出する（`buildDuplicateReplyIndex` 参照）。1つのルールは1アカウント分の bundle しか
   * 見ないため。この値を持たない bundle（多くのルール単体テストなど）では 0 として扱う。
   */
  templatedReplyNetworkSize?: number
  /**
   * このアカウントが参加した「リプライハイジャック集団」の最大規模。5アカウント以上
   * （このアカウントを含む）が、24時間以内に同じ対象ツイートへそれぞれ言い換えつつ類似した
   * リプライを1件だけ投稿し、他人のバズったツイートの露出を横取りする集団を指す。該当なしの
   * 場合は 0（または未設定）。ルールごとではなく、クロール/再ラベリング実行ごとに共有
   * コーパスから一度だけ算出する（`buildReplyHijackIndex` 参照）。この点は
   * `templatedReplyNetworkSize` と同じ。
   */
  replyHijackSwarmSize?: number
}

export interface LabelRuleResult {
  value: boolean
  /**
   * 陽性判定（`value: true`）をどれだけの証拠が裏付けているかを表す、おおよそ `[0, 1]` の
   * 範囲の値。`confidence` は `value` と組み合わせて初めて意味を持つ。`value` が `false` の
   * 場合でも `confidence` が非ゼロになることがある（各ルールが陰性側でも部分的な兆候の強さを
   * 反映させるために使う場合がある）。`value` を確認せずに `confidence` 単体で意味があるものと
   * みなさないこと。
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
