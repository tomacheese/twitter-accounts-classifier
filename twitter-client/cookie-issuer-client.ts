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

  constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CookieIssuerError'
    this.status = status
  }
}

export interface CookieIssuerClientOptions {
  baseUrl: string
  /** Cookie Issuer への request で送る `X-Client-Name` header の値。呼び出し元 (`crawler`/`blocker` 等) を識別するための非機密な固定文字列。 */
  clientName?: string
  fetchImpl?: typeof fetch
  sleepImpl?: (ms: number) => Promise<void>
}

export interface RetryOptions {
  maxAttempts?: number
  /** retry 間隔の基準値 (ミリ秒)。attempt が進むほど待機時間を線形に増やす際に用いる。 */
  delayMs?: number
  /**
   * retry 間の sleep の累積時間 (ミリ秒) の上限。
   * HTTP request/response 自体の wall-clock 時間は含まない end-to-end 以外の timeout であり、Cookie Issuer 側の lock 待機 timeout とは同一視しないこと。
   */
  maxTotalWaitMs?: number
}

export function createCookieIssuerClient(options: CookieIssuerClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch
  const sleepImpl =
    options.sleepImpl ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

  async function issueCookies(account: CookieIssuerAccount): Promise<IssuedCookies> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }
    if (options.clientName) headers['X-Client-Name'] = options.clientName

    const response = await fetchImpl(`${options.baseUrl}/login`, {
      method: 'POST',
      headers,
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
    // maxAttempts の既定値は、線形 backoff の累積待機が maxTotalWaitMs に達する attempt 数より 1 大きくしてあり、
    // maxTotalWaitMs の上限が実際に効くようにしている。
    const maxAttempts = retry.maxAttempts ?? 11
    const delayMs = retry.delayMs ?? 3000
    const maxTotalWaitMs = retry.maxTotalWaitMs ?? 150_000
    let cumulativeWaitMs = 0
    let lastAttempt = 0
    let lastError: unknown

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      lastAttempt = attempt
      try {
        return await issueCookies(account)
      } catch (error) {
        lastError = error
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
      { cause: lastError },
    )
  }

  return { issueCookies, issueCookiesWithRetry }
}
