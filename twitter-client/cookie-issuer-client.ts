export interface CookieIssuerAccount {
  username: string
  password: string
  otp_secret: string | null
}

export interface IssuedCookies {
  ct0: string
  authToken: string
}

export class CookieIssuerError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'CookieIssuerError'
    this.status = status
  }
}

export interface CookieIssuerClientOptions {
  baseUrl: string
  fetchImpl?: typeof fetch
  sleepImpl?: (ms: number) => Promise<void>
}

export interface RetryOptions {
  maxAttempts?: number
  /**
   * attempt ごとの待機を線形に増やす (`delayMs * attempt`) ための基準値 (ミリ秒)。
   */
  delayMs?: number
  /**
   * retry 間の sleep の累積時間 (ミリ秒) の上限。
   * HTTP request/response 自体の wall-clock 時間は含まない。
   * Cookie Issuer 側の lock 待機 timeout (`LOGIN_LOCK_TIMEOUT_SECONDS`) とは種類が異なる。
   * 両者を同一の end-to-end timeout として扱わないこと。
   */
  maxTotalWaitMs?: number
}

export function createCookieIssuerClient(options: CookieIssuerClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch
  const sleepImpl =
    options.sleepImpl ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

  async function issueCookies(account: CookieIssuerAccount): Promise<IssuedCookies> {
    const response = await fetchImpl(`${options.baseUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(account),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new CookieIssuerError(
        `cookie-issuer login failed with status ${response.status}: ${body}`,
        response.status,
      )
    }

    const data = (await response.json()) as { status: string; ct0: string; auth_token: string }
    return { ct0: data.ct0, authToken: data.auth_token }
  }

  async function issueCookiesWithRetry(
    account: CookieIssuerAccount,
    retry: RetryOptions = {},
  ): Promise<IssuedCookies> {
    const maxAttempts = retry.maxAttempts ?? 10
    const delayMs = retry.delayMs ?? 3000
    const maxTotalWaitMs = retry.maxTotalWaitMs ?? 150_000
    let cumulativeWaitMs = 0
    let lastAttempt = 0

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      lastAttempt = attempt
      try {
        return await issueCookies(account)
      } catch (error) {
        const isBusy = error instanceof CookieIssuerError && error.status === 409
        if (!isBusy) throw error
        if (attempt === maxAttempts) break
        const nextWaitMs = delayMs * attempt
        if (cumulativeWaitMs + nextWaitMs > maxTotalWaitMs) break
        await sleepImpl(nextWaitMs)
        cumulativeWaitMs += nextWaitMs
      }
    }

    throw new CookieIssuerError(
      `Cookie Issuer busy: exhausted ${lastAttempt} attempts over ${cumulativeWaitMs}ms (last status 409)`,
      409,
    )
  }

  return { issueCookies, issueCookiesWithRetry }
}
