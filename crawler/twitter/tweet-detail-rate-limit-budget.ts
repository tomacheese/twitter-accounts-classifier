export type TweetDetailFetchDecision = 'allowed' | 'budget_skipped' | 'rate_limit_skipped'

export interface TweetDetailRateLimitDiagnostics {
  rateLimitLimit?: number
  rateLimitRemaining?: number
  rateLimitReset?: number
}

export interface TweetDetailRateLimitBudgetOptions {
  now: () => number
  fallbackRequests?: number
}

interface TweetDetailBudgetState {
  remaining?: number
  resetAtMs?: number
  circuitOpenUntilMs?: number
}

/**
 * `getTweetDetail` は `fetchReplies` と parent ツイート取得の両方が呼ぶ単一エンドポイントであるため、
 * `FollowRateLimitBudget` と異なり bucket を分けない単一状態で quota を管理する。
 */
export class TweetDetailRateLimitBudget {
  private readonly state: TweetDetailBudgetState = {}
  private fallbackRemaining: number

  constructor(private readonly options: TweetDetailRateLimitBudgetOptions) {
    this.fallbackRemaining = options.fallbackRequests ?? 450
  }

  /** parent ツイート取得は受信リプライ検出と異なり必須の呼び出しではないため、quota 逼迫時は積極的に後退させる。 */
  acquireOptionalFetch(): TweetDetailFetchDecision {
    this.resetExpiredState()
    if (
      this.state.circuitOpenUntilMs !== undefined &&
      this.state.circuitOpenUntilMs > this.options.now()
    ) {
      return 'rate_limit_skipped'
    }
    if (this.state.remaining !== undefined && this.state.remaining <= 0) return 'budget_skipped'
    if (this.fallbackRemaining <= 0) return 'budget_skipped'

    if (this.state.remaining !== undefined) this.state.remaining -= 1
    this.fallbackRemaining -= 1
    return 'allowed'
  }

  /** fallback 予算ではなく実測ヘッダーを優先し、固定値による過小/過大評価を避ける。 */
  recordSuccess(diagnostics: TweetDetailRateLimitDiagnostics): void {
    if (diagnostics.rateLimitRemaining !== undefined) {
      this.state.remaining = diagnostics.rateLimitRemaining
    }
    if (diagnostics.rateLimitReset !== undefined) {
      this.state.resetAtMs = diagnostics.rateLimitReset * 1000
    }
  }

  /** 429 を受けた場合、server reset まで以降の optional fetch を止める。 */
  recordRateLimited(diagnostics: TweetDetailRateLimitDiagnostics): void {
    this.state.remaining = 0
    this.state.resetAtMs =
      diagnostics.rateLimitReset === undefined ? undefined : diagnostics.rateLimitReset * 1000
    this.state.circuitOpenUntilMs = this.state.resetAtMs ?? Number.POSITIVE_INFINITY
  }

  /** 再開時に checkpoint 済みの呼び出し回数を控除し、未知の quota を過大評価しない。 */
  restoreFetchCount(requestCount: number): void {
    this.fallbackRemaining = Math.max(0, this.fallbackRemaining - Math.max(0, requestCount))
  }

  /** 再開時に 429 済み checkpoint を見つけたら、この cycle の optional fetch を安全側に止める。 */
  restoreRateLimit(): void {
    this.state.remaining = 0
    this.state.circuitOpenUntilMs = Number.POSITIVE_INFINITY
  }

  private resetExpiredState(): void {
    if (this.state.resetAtMs === undefined || this.state.resetAtMs > this.options.now()) return
    this.state.remaining = undefined
    this.state.resetAtMs = undefined
    this.state.circuitOpenUntilMs = undefined
    this.fallbackRemaining = this.options.fallbackRequests ?? 450
  }
}
