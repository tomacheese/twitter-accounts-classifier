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
  /**
   * cookie-issuer が timeout/network error 等により cookie の有効性を確定できなかった
   * (503 + `status: indeterminate`) ことを示す。確定 invalid とは区別し、
   * このフラグが立った失敗を再ログインの根拠として扱ってはならない。
   */
  readonly indeterminate: boolean

  constructor(message: string, status?: number, indeterminate = false, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CookieIssuerError'
    this.status = status
    this.indeterminate = indeterminate
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
  /**
   * 503 indeterminate (有効性を確定できない) に対する再検証の最大試行回数。
   * 409 busy の retry budget とは意味が異なる (確定 invalid でも busy でもない) ため、独立させている。
   */
  indeterminateMaxAttempts?: number
  /** 503 indeterminate 再検証の間隔 (ミリ秒)。 */
  indeterminateDelayMs?: number
}

function isIndeterminateBody(bodyText: string): boolean {
  try {
    const parsed = JSON.parse(bodyText) as { status?: unknown }
    return parsed.status === 'indeterminate'
  } catch {
    return false
  }
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
      const bodyText = await response.text()
      // 503 は cookie-issuer 側が timeout/network error 等で有効性を確定できなかった場合に返り、
      // 確定 invalid とは意味が異なる (再ログインの根拠にしてはならない) ため個別に判定する。
      if (response.status === 503 && isIndeterminateBody(bodyText)) {
        throw new CookieIssuerError(
          `cookie-issuer could not determine cookie validity (503 indeterminate): ${bodyText}`,
          503,
          true,
        )
      }
      throw new CookieIssuerError(
        `cookie-issuer login failed with status ${response.status}: ${bodyText}`,
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
    const indeterminateMaxAttempts = retry.indeterminateMaxAttempts ?? 5
    const indeterminateDelayMs = retry.indeterminateDelayMs ?? 5000

    let cumulativeWaitMs = 0
    let busyAttempt = 0
    let indeterminateAttempt = 0
    let lastError: unknown

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await issueCookies(account)
      } catch (error) {
        lastError = error

        // indeterminate の retry budget は busy(409) の attempt/maxAttempts を消費しない:
        // 両者は原因が異なり、片方の再試行上限に達したからといってもう一方を打ち切る理由にならないため。
        if (error instanceof CookieIssuerError && error.indeterminate) {
          indeterminateAttempt++
          if (indeterminateAttempt >= indeterminateMaxAttempts) {
            throw new CookieIssuerError(
              `Cookie Issuer could not determine cookie validity: exhausted ${indeterminateAttempt} attempts (last status 503 indeterminate)`,
              503,
              true,
              { cause: lastError },
            )
          }
          await sleepImpl(indeterminateDelayMs)
          attempt--
          continue
        }

        busyAttempt = attempt
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
      `Cookie Issuer busy: exhausted ${busyAttempt} attempts over ${cumulativeWaitMs}ms (last status 409)`,
      409,
      false,
      { cause: lastError },
    )
  }

  return { issueCookies, issueCookiesWithRetry }
}
