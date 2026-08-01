/** author 処理の失敗について安全に記録できる HTTP 応答情報。 */
export interface ResponseErrorDiagnostics {
  httpStatus: number
  retryAfterSeconds?: number
  rateLimitLimit?: number
  rateLimitRemaining?: number
  rateLimitReset?: number
}

interface ResponseHeadersLike {
  get(name: string): unknown
}

const HTTP_STATUS_MIN = 100
const HTTP_STATUS_MAX = 599

/** 不安定な export path を import せず、生成クライアントの ResponseError を識別する。 */
export function isResponseError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'ResponseError'
}

/** Response data を保持せずに、調査に必要な stack trace を log 用 Error へ複製する。 */
export function toSafeResponseErrorForLog(error: Error): Error {
  const safeError = new Error('ResponseError')
  safeError.name = 'ResponseError'
  const stackLines = error.stack?.split('\n')
  if (stackLines && stackLines.length > 1) {
    safeError.stack = [safeError.toString(), ...stackLines.slice(1)].join('\n')
  }
  return safeError
}

/**
 * HTTP-date、小数、指数表記、任意の文字列形式を除いた非負の 10 進整数を返す。
 * 診断値を小さく予測可能な集合に限定する。
 */
function parseNonNegativeDecimalInteger(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return undefined

  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/**
 * response object や任意の header を呼び出し元へ公開せず、許可した数値 header を 1 つ読む。
 */
function getNumericHeader(headers: unknown, name: string): number | undefined {
  if (
    typeof headers !== 'object' ||
    headers === null ||
    typeof (headers as Partial<ResponseHeadersLike>).get !== 'function'
  ) {
    return undefined
  }

  try {
    return parseNonNegativeDecimalInteger((headers as ResponseHeadersLike).get(name))
  } catch {
    return undefined
  }
}

/**
 * 生成クライアントの ResponseError から、固定された非機微情報の診断 subset を抽出する。
 * 不正な response object または status 値では診断を返さない。不正な header 値は、信頼できない
 * response data を直列化する代わりに省略する。
 */
export function getResponseErrorDiagnostics(error: unknown): ResponseErrorDiagnostics | undefined {
  if (!isResponseError(error)) return undefined

  try {
    const response = (error as { response?: unknown }).response
    if (typeof response !== 'object' || response === null) return undefined

    const status = (response as { status?: unknown }).status
    if (
      typeof status !== 'number' ||
      !Number.isInteger(status) ||
      status < HTTP_STATUS_MIN ||
      status > HTTP_STATUS_MAX
    ) {
      return undefined
    }

    const headers = (response as { headers?: unknown }).headers
    const diagnostics: ResponseErrorDiagnostics = {
      httpStatus: status,
    }
    const retryAfterSeconds = getNumericHeader(headers, 'retry-after')
    if (retryAfterSeconds !== undefined) diagnostics.retryAfterSeconds = retryAfterSeconds
    const rateLimitLimit = getNumericHeader(headers, 'x-rate-limit-limit')
    if (rateLimitLimit !== undefined) diagnostics.rateLimitLimit = rateLimitLimit
    const rateLimitRemaining = getNumericHeader(headers, 'x-rate-limit-remaining')
    if (rateLimitRemaining !== undefined) diagnostics.rateLimitRemaining = rateLimitRemaining
    const rateLimitReset = getNumericHeader(headers, 'x-rate-limit-reset')
    if (rateLimitReset !== undefined) diagnostics.rateLimitReset = rateLimitReset
    return diagnostics
  } catch {
    return undefined
  }
}

/** 信頼できない response text を含めず、診断情報を log message 用に整形する。 */
export function formatResponseErrorDiagnostics(diagnostics: ResponseErrorDiagnostics): string {
  const fields = [`httpStatus=${String(diagnostics.httpStatus)}`]
  if (diagnostics.retryAfterSeconds !== undefined) {
    fields.push(`retryAfterSeconds=${String(diagnostics.retryAfterSeconds)}`)
  }
  if (diagnostics.rateLimitLimit !== undefined) {
    fields.push(`rateLimitLimit=${String(diagnostics.rateLimitLimit)}`)
  }
  if (diagnostics.rateLimitRemaining !== undefined) {
    fields.push(`rateLimitRemaining=${String(diagnostics.rateLimitRemaining)}`)
  }
  if (diagnostics.rateLimitReset !== undefined) {
    fields.push(`rateLimitReset=${String(diagnostics.rateLimitReset)}`)
  }
  return fields.join(', ')
}
