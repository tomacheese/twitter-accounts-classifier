import type { FollowGraphLabelSignal } from './follow-graph-label-index'

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
     * X API の `user.parodyCommentaryFanLabel`（'None' | 'Parody' | 'Commentary' | 'Fan'）の値。
     * 任意項目にする理由は `professionalType` と同じ。
     */
    parodyCommentaryFanLabel?: string | null
    /**
     * `Account.recentTweetsFetchStatus` の値 (`'success' | 'failed'` 等)。
     * `recentTweets` が「取得済みで証拠なし」なのか「未取得のため空」なのかを区別できないと、
     * ルールが未取得を確信度の高い陰性と誤認してしまうため、bundle 側にも伝播させる。
     * この項目が存在する前に作られたルール単体テストの bundle も無修正でコンパイルが通るよう、
     * 任意項目にし、省略時は取得済みとして扱う (`professionalType` と同じ理由)。
     */
    recentTweetsFetchStatus?: string | null
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
    /** X URL entity から正規化した展開先 URL。旧 fixture 互換のため任意。 */
    expandedUrls?: string[]
    /**
     * このツイートが直接リプライしている先のツイート ID。リプライでない場合、
     * または親ツイート ID が不明な場合は `null`/未設定にする。
     * 任意項目にする理由は `professionalType` と同じ。
     */
    inReplyToTweetId?: string | null
    /**
     * X のコンテンツ開示 API が、このツイートに AI 生成メディアが含まれると判定したか。
     * `null` は「一度も評価されていない」(旧ツイートや開示情報のない取得経路) ことを表し、
     * 「取得の結果 AI 生成メディアなしと確定した」ことを表す `false` とは区別する。
     * 任意項目にする理由は `inReplyToTweetId` と同じ。
     */
    hasAiGeneratedMedia?: boolean | null
    /**
     * 上記の AI 生成メディアフラグをどう判定したか。
     * 値は `'C2paClient' | 'ContentDisclosureAiGeneratedDisclosure' | 'UserDeclared'`。
     * `hasAiGeneratedMedia` が `true` でない場合は `null`/未設定にする。
     */
    aiGeneratedDetectionSource?: string | null
    /**
     * X がこのツイートの投稿者以外を出典として示す添付動画の件数。
     * 過去の収集結果から作られた bundle との互換性を保つため optional にする。
     */
    foreignVideoSourceCount?: number | null
    /**
     * このツイートが引用しているツイートの投稿者 ID。引用ツイートでない場合、
     * または引用先ツイートの投稿者 ID が不明な場合は `null`/未設定にする。
     * 任意項目にする理由は `inReplyToTweetId` と同じ。
     */
    quotedTweetAuthorId?: string | null
    /**
     * 引用元ツイート自体のメディアに動画または GIF が含まれるか。
     * 「未確認 (`null`) か確定済みか」という区別は `hasAiGeneratedMedia` と同じ規約で、
     * 詳細は `prisma/schema.prisma` の `Tweet.quotedTweetHasVideo` を参照。
     * 任意項目にする理由は `quotedTweetAuthorId` と同じ。
     */
    quotedTweetHasVideo?: boolean | null
    /**
     * このツイートがリプライしている parent ツイートの本文。
     * parent が未取得・削除済みなどで解決できない場合は `null`/未設定にする。
     * 任意項目にする理由は `inReplyToTweetId` と同じ。
     */
    parentTweetFullText?: string | null
  }[]
  /**
   * URL・メンション除去後、この投稿者自身のいずれかのリプライ本文と完全一致するリプライを投稿した、
   * 他アカウントの最大観測数。定型文を使い回す量産型リプライボット網の特徴を示す。
   * 一致した全リプライが同一ツイート宛てと確認できた場合は、ハッシュタグキャンペーン等の
   * 偶発的一致として 0 にする。
   * ルールごとではなく実行ごとに共有コーパスから一度算出する（`buildDuplicateReplyIndex` 参照）。
   * 1つのルールは1アカウント分の bundle しか見ないため。
   * この値を持たない bundle（多くのルール単体テストなど）では 0 として扱う。
   */
  templatedReplyNetworkSize?: number
  /**
   * このアカウントが参加した「リプライハイジャック集団」の最大規模。
   * 5アカウント以上（本人含む）が24時間以内に同一対象へ言い換えつつ類似リプライを1件だけ投稿し、
   * 他人のバズったツイートの露出を横取りする集団を指す。該当なしの場合は 0（または未設定）。
   * ルールごとではなく実行ごとに共有コーパスから一度算出する（`buildReplyHijackIndex` 参照）。
   * この点は `templatedReplyNetworkSize` と同じ。
   */
  replyHijackSwarmSize?: number
  /**
   * このアカウントのフォロー先・フォロワーにおける、ラベルごとの既存付与状況。
   * ルールごとではなく実行ごとに共有インデックスから一度算出する（`buildFollowGraphLabelIndex` 参照）。
   * 今回の実行で新たに確定したラベルは含まず、
   * 実行開始時点で `AccountLabelLatest` に永続化済みだった値のみを反映する。
   * この値を持たない bundle（多くのルール単体テストなど）では空オブジェクトとして扱う。
   */
  followGraphLabelSignals?: Record<string, FollowGraphLabelSignal | undefined>
}

export interface LabelRuleResult {
  value: boolean
  /**
   * 現在の `value` がどれだけ確からしいかを表す、校正されていない heuristic な決定スコア `[0, 1]`。
   * 真の確率 `P(value が正しい)` としては扱わない。
   * 証拠が全く無い場合、`value=true` なら 0、`value=false` なら 1 に近づく
   * (陽性の気配が無いこと自体が陰性側の強い根拠になるため)。
   */
  confidence: number
  reason: string
  /**
   * サンプル不足などの理由で `value` を意味のある形で判定できなかったかどうか。
   * `false` の場合、`confidence` は `value`/evidenceScore に関わらず 0.5 (中立値) になる。
   * 省略時は `true` (通常どおり判定できた) として扱う。
   */
  evaluable?: boolean
}

export interface LabelRule {
  key: string
  description: string
  /**
   * ルールの判定ロジックのバージョン。判定ロジックだけでなく、
   * confidence/evidence の算出式を変更する場合も必ず bump すること。
   * blocker はこの値と `AccountLabelLatest.ruleVersion` の一致を要求するため、
   * bump しないまま算出式だけ変えると新旧の confidence が同一 `ruleVersion` の下で混在してしまう。
   */
  version: string
  /**
   * `hasFollowGraphTopicSignal()` を呼び follow-graph signal を利用するルールが明示的に true を宣言する。
   * `buildFollowGraphLabelIndex()` の呼び出し元がこのフラグで対象ラベルを絞り込む。
   */
  usesFollowGraphSignal?: boolean
  evaluate(bundle: AccountFeatureBundle): LabelRuleResult
}
