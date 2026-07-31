/**
 * One HTTP response observed while passing through {@link wrapFetchWithResponseCapture}.
 */
export interface CapturedResponse {
  url: string
  status: number
  body: string
  capturedAt: Date
}

/**
 * Hard cap on how many responses {@link responseBuffer} keeps at once. This is a
 * diagnostic aid for investigating the rare parse failure, not a durable log - an
 * unbounded buffer would grow for the lifetime of a long-running crawl process.
 */
const MAX_CAPTURED_RESPONSES = 20

/**
 * Hard cap on how many characters of a single response body are retained. Some
 * timeline responses can be very large; truncating keeps memory bounded even though
 * the full body is not needed to diagnose a shape mismatch (the failure point is
 * almost always visible near the start of the JSON).
 */
const MAX_BODY_LENGTH = 20_000

const TRUNCATION_MARKER = '... [truncated]'

/**
 * Most-recently-observed HTTP responses, oldest first. `twitter-openapi-typescript`
 * performs fetch + parse + convert in one method call, so by the time our code catches
 * a parse failure thrown deep inside the library, the raw response body that caused it
 * is already gone - it was never captured anywhere. This buffer exists purely so that
 * failure can be investigated after the fact, by recovering the response that was being
 * parsed at the time.
 */
let responseBuffer: CapturedResponse[] = []

/**
 * Appends one response to {@link responseBuffer}, truncating an oversized body and
 * evicting the oldest entry once the buffer exceeds {@link MAX_CAPTURED_RESPONSES}.
 * @param url - the request URL the response was received for
 * @param status - the response's HTTP status
 * @param body - the response body text
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
 * Wraps a `fetch` implementation so every response passing through it is also recorded
 * into {@link responseBuffer}, without altering what the real caller receives. Uses
 * `response.clone()` because the original `Response` body must remain consumable by the
 * real caller - reading it directly here would leave nothing for the library to parse.
 * The clone's body is read (and recorded) before this function returns, rather than
 * left as a fire-and-forget promise - the whole point of this buffer is to still hold
 * the response by the time a parse failure further up the call stack is caught, and a
 * detached read could otherwise lose that race.
 * @param fetchImpl - the `fetch` implementation to wrap, e.g. one backed by `cycletls`
 * @returns a `fetch`-compatible function that captures a copy of every response
 */
export function wrapFetchWithResponseCapture(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init)
    const url = input instanceof Request ? input.url : String(input)
    // Body capture must never fail the real call it's piggybacking on - a body that
    // can't be read as text (or any other error here) is simply left unrecorded.
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
 * Finds the most recently captured response whose URL contains `urlSubstring`,
 * searching from most-recent backward. Lets a timeline-fetch failure handler recover
 * "what did X actually return" for the specific GraphQL endpoint that just failed,
 * identified by its path segment (e.g. `HomeTimeline`), without needing to correlate
 * requests and responses at the fetch layer itself.
 * @param urlSubstring - a substring identifying the endpoint, e.g. `HomeTimeline`
 * @returns the matching response, or `undefined` if none was captured
 */
export function getLastResponseMatching(urlSubstring: string): CapturedResponse | undefined {
  for (let i = responseBuffer.length - 1; i >= 0; i--) {
    if (responseBuffer[i].url.includes(urlSubstring)) {
      return responseBuffer[i]
    }
  }
  return undefined
}
