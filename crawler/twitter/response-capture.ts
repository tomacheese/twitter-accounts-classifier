export interface CapturedResponse {
  url: string
  status: number
  body: string
  capturedAt: Date
}

/**
 * まれに発生するパース失敗の調査用であり永続的なログではないため、常駐プロセスの
 * 生存期間中に無制限に増え続けないよう上限を設けている。
 */
const MAX_CAPTURED_RESPONSES = 20

/**
 * タイムラインのレスポンスは非常に大きくなり得るが、形状不一致の原因は JSON の
 * 先頭付近で判明することがほとんどで本文全体は不要なため、切り詰めてメモリ使用量を
 * 抑えている。
 */
const MAX_BODY_LENGTH = 20_000

const TRUNCATION_MARKER = '... [truncated]'

/**
 * `twitter-openapi-typescript` は fetch・パース・変換を 1 つのメソッド呼び出しに
 * まとめているため、ライブラリ内部で投げられたパース失敗をこちら側で捕捉した時点
 * では原因となった生レスポンスはどこにも残っていない。事後に失敗を調査できるよう、
 * このバッファでレスポンスを保持している。
 */
let responseBuffer: CapturedResponse[] = []

/**
 * @param url - レスポンスを受け取ったリクエストの URL
 * @param status - レスポンスの HTTP ステータス
 * @param body - レスポンス本文のテキスト
 */
function recordResponse(url: string, status: number, body: string): void {
  const truncatedBody =
    body.length > MAX_BODY_LENGTH ? body.slice(0, MAX_BODY_LENGTH) + TRUNCATION_MARKER : body
  responseBuffer.push({ url, status, body: truncatedBody, capturedAt: new Date() })
  if (responseBuffer.length > MAX_CAPTURED_RESPONSES) {
    responseBuffer = responseBuffer.slice(responseBuffer.length - MAX_CAPTURED_RESPONSES)
  }
}

/**
 * `response.clone()` を使っているのは、元の `Response` の本文を呼び出し元が
 * 引き続き消費できる必要があるため。ここで直接読み取ってしまうと、ライブラリが
 * パースするための本文が残らなくなる。また clone の本文はこの関数が返る前に
 * 読み切って記録している。呼び出し後に投げっぱなしの Promise にすると、上位で
 * パース失敗が捕捉される時点までにバッファへの記録が間に合わない可能性がある。
 * @param fetchImpl - the `fetch` implementation to wrap, e.g. one backed by `cycletls`
 * @returns a `fetch`-compatible function that captures a copy of every response
 */
export function wrapFetchWithResponseCapture(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init)
    const url = input instanceof Request ? input.url : String(input)
    // 本来の呼び出しを失敗させてはならないため、
    // 本文をテキストとして読めない場合なども含め、
    // ここで発生したエラーは記録を諦めるだけに留める。
    try {
      const body = await response.clone().text()
      recordResponse(url, response.status, body)
    } catch {
      /* empty */
    }
    return response
  }
}

/**
 * fetch 層でリクエストとレスポンスを紐付ける仕組みを別途用意せずに済むよう、
 * エンドポイントのパス断片による検索だけで該当レスポンスを引けるようにしている。
 * @param urlSubstring - エンドポイントを識別する部分文字列 (例: `HomeTimeline`)
 * @returns 一致したレスポンス、キャプチャされていなければ `undefined`
 */
export function getLastResponseMatching(urlSubstring: string): CapturedResponse | undefined {
  for (let i = responseBuffer.length - 1; i >= 0; i--) {
    if (responseBuffer[i].url.includes(urlSubstring)) {
      return responseBuffer[i]
    }
  }
  return undefined
}
