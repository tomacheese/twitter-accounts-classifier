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
  delayMs?: number
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
    const maxAttempts = retry.maxAttempts ?? 5
    const delayMs = retry.delayMs ?? 3000
    let lastError: unknown

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await issueCookies(account)
      } catch (error) {
        lastError = error
        const isBusy = error instanceof CookieIssuerError && error.status === 409
        if (!isBusy || attempt === maxAttempts) {
          throw error
        }
        await sleepImpl(delayMs)
      }
    }

    throw lastError
  }

  return { issueCookies, issueCookiesWithRetry }
}
