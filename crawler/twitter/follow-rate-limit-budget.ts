export type FollowRateLimitBucket = 'Following' | 'Followers'
export type OptionalFollowingDecision = 'allowed' | 'budget_skipped' | 'rate_limit_skipped'

export interface FollowRateLimitDiagnostics {
  rateLimitLimit?: number
  rateLimitRemaining?: number
  rateLimitReset?: number
}

export interface FollowRateLimitBudgetOptions {
  now: () => number
  fallbackFollowingRequests?: number
}

export class OptionalFollowingSkipError extends Error {
  constructor(readonly decision: Exclude<OptionalFollowingDecision, 'allowed'>) {
    super(`Optional Following request skipped: ${decision}`)
    this.name = 'OptionalFollowingSkipError'
  }
}

interface BucketState {
  remaining?: number
  resetAtMs?: number
  circuitOpenUntilMs?: number
}

/**
 * Follow API の endpoint ごとの quota を、optional な Following sample を優先的に抑制するために管理する。
 */
export class FollowRateLimitBudget {
  private readonly states = new Map<FollowRateLimitBucket, BucketState>()
  private fallbackFollowingRemaining: number

  constructor(private readonly options: FollowRateLimitBudgetOptions) {
    this.fallbackFollowingRemaining = options.fallbackFollowingRequests ?? 450
  }

  /** optional Following request を送ってよいか判定し、送る場合は予約する。 */
  acquireOptionalFollowing(): OptionalFollowingDecision {
    const state = this.stateFor('Following')
    this.resetExpiredState(state)
    if (state.circuitOpenUntilMs !== undefined && state.circuitOpenUntilMs > this.options.now()) {
      return 'rate_limit_skipped'
    }
    if (state.remaining !== undefined && state.remaining <= 0) return 'budget_skipped'
    if (this.fallbackFollowingRemaining <= 0) return 'budget_skipped'

    if (state.remaining !== undefined) state.remaining -= 1
    this.fallbackFollowingRemaining -= 1
    return 'allowed'
  }

  /** 再開時に checkpoint 済みの optional request を控除し、未知の quota を過大評価しない。 */
  restoreOptionalFollowingRequests(requestCount: number): void {
    this.fallbackFollowingRemaining = Math.max(
      0,
      this.fallbackFollowingRemaining - Math.max(0, requestCount),
    )
  }

  /** 再開時に 429 済み checkpoint を見つけたら、この cycle の optional request を安全側に止める。 */
  restoreOptionalFollowingRateLimit(): void {
    const state = this.stateFor('Following')
    state.remaining = 0
    state.circuitOpenUntilMs = Number.POSITIVE_INFINITY
  }

  /** 再開時に最後に観測した Following quota を復元する。 */
  restoreFollowingQuota(diagnostics: FollowRateLimitDiagnostics): void {
    this.recordSuccess('Following', diagnostics)
  }

  /** priority operation を開始できるか判定する。 */
  canStart(bucket: FollowRateLimitBucket): boolean {
    const state = this.stateFor(bucket)
    this.resetExpiredState(state)
    return state.remaining === undefined || state.remaining > 0
  }

  /** successful response の安全な quota diagnostics を bucket に反映する。 */
  recordSuccess(bucket: FollowRateLimitBucket, diagnostics: FollowRateLimitDiagnostics): void {
    const state = this.stateFor(bucket)
    if (diagnostics.rateLimitRemaining !== undefined)
      state.remaining = diagnostics.rateLimitRemaining
    if (diagnostics.rateLimitReset !== undefined)
      state.resetAtMs = diagnostics.rateLimitReset * 1000
  }

  /** 429 を受けた optional request 以降を server reset まで止める。 */
  recordRateLimited(bucket: FollowRateLimitBucket, diagnostics: FollowRateLimitDiagnostics): void {
    const state = this.stateFor(bucket)
    state.remaining = 0
    state.resetAtMs =
      diagnostics.rateLimitReset === undefined ? undefined : diagnostics.rateLimitReset * 1000
    state.circuitOpenUntilMs = state.resetAtMs ?? Number.POSITIVE_INFINITY
  }

  private stateFor(bucket: FollowRateLimitBucket): BucketState {
    let state = this.states.get(bucket)
    if (!state) {
      state = {}
      this.states.set(bucket, state)
    }
    return state
  }

  private resetExpiredState(state: BucketState): void {
    if (state.resetAtMs === undefined || state.resetAtMs > this.options.now()) return
    state.remaining = undefined
    state.resetAtMs = undefined
    state.circuitOpenUntilMs = undefined
    this.fallbackFollowingRemaining = this.options.fallbackFollowingRequests ?? 450
  }
}
