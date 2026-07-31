import type { IssuedCookies } from '../auth/cookie-issuer-client'
import type { TrendsScraperLike } from './timeline'

// `@the-convocation/twitter-scraper`'s own getTrends() hits this same bearer token and
// endpoint, but its installAuthCredentials() only fetches/attaches an `x-guest-token`
// `if (!bearerTokenOverride)` — and getTrends() always passes this token as an override,
// so it never attaches a guest token at all. `guide.json` then rejects the cookie-only
// request with HTTP 400, code 215 "Bad Authentication data", confirmed by reading that
// library's source directly (no fix available upstream as of 0.22.3). We reimplement the
// request here so a guest token scoped to this same bearer token is actually attached.
const TRENDS_BEARER_TOKEN =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'

/**
 * Shape of a `guide.json` response, down to the exact entry path
 * {@link parseTrendNames} reads trend names from.
 */
interface GuideJsonResponse {
  timeline?: {
    instructions?: {
      addEntries?: {
        entries?: {
          content?: {
            timelineModule?: {
              items?: {
                item?: {
                  clientEventInfo?: {
                    details?: {
                      guideDetails?: {
                        transparentGuideDetails?: {
                          trendMetadata?: { trendName?: string }
                        }
                      }
                    }
                  }
                }
              }[]
            }
          }
        }[]
      }
    }[]
  }
}

/**
 * Activates a guest token scoped to {@link TRENDS_BEARER_TOKEN}, required to pair with
 * that bearer token on subsequent `guide.json` requests (see the comment above
 * {@link TRENDS_BEARER_TOKEN} for why this pairing is necessary).
 * @param fetchImpl - fetch implementation to issue the request with
 * @returns the activated guest token
 */
async function fetchGuestToken(fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl('https://api.x.com/1.1/guest/activate.json', {
    method: 'POST',
    headers: { authorization: `Bearer ${TRENDS_BEARER_TOKEN}` },
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `Failed to activate guest token for trends: HTTP ${response.status}${body ? ` - ${body}` : ''}`,
    )
  }
  const data = (await response.json()) as { guest_token?: string }
  if (!data.guest_token) {
    throw new Error('Guest token activation response missing guest_token')
  }
  return data.guest_token
}

/**
 * Extracts trend names from a `guide.json` response, mirroring the entry path
 * `@the-convocation/twitter-scraper`'s own `getTrends()` parser uses.
 * @param payload - the parsed `guide.json` response body
 * @returns the trend names found; an empty array means the response shape matched but
 * carried zero trend items
 * @throws if the response doesn't match the expected shape at all (e.g. X changed the
 * `guide.json` schema) — kept distinct from the empty-array case so callers don't
 * mistake a schema-drift break for a legitimate "no trends right now" response
 */
function parseTrendNames(payload: GuideJsonResponse): string[] {
  const instructions = payload.timeline?.instructions ?? []
  if (instructions.length < 2) {
    throw new Error('Unexpected guide.json response shape: missing timeline instructions')
  }
  const entries = instructions[1].addEntries?.entries ?? []
  if (entries.length < 2) {
    throw new Error('Unexpected guide.json response shape: missing addEntries entries')
  }
  const items = entries[1].content?.timelineModule?.items ?? []

  const trends: string[] = []
  for (const item of items) {
    const trendName =
      item.item?.clientEventInfo?.details?.guideDetails?.transparentGuideDetails?.trendMetadata
        ?.trendName
    if (trendName != null) trends.push(trendName)
  }
  return trends
}

/**
 * Creates a {@link TrendsScraperLike} backed by our own `guide.json` request, correctly
 * pairing a guest token with the fixed bearer token the endpoint requires (see
 * {@link TRENDS_BEARER_TOKEN}'s comment for why the upstream scraper library cannot do this).
 * @param cookies - the account's ct0/auth_token cookie pair
 * @param fetchImpl - fetch implementation to issue requests with, e.g. a cycletls-backed
 * fetch presenting a genuine Chrome TLS fingerprint
 * @returns an object exposing `getTrends()`
 */
export function createTrendsClient(
  cookies: IssuedCookies,
  fetchImpl: typeof fetch,
): TrendsScraperLike {
  return {
    async getTrends(): Promise<string[]> {
      const guestToken = await fetchGuestToken(fetchImpl)
      const params = new URLSearchParams({
        count: '20',
        candidate_source: 'trends',
        include_page_configuration: 'false',
        entity_tokens: 'false',
      })
      const response = await fetchImpl(`https://api.x.com/2/guide.json?${params.toString()}`, {
        headers: {
          authorization: `Bearer ${TRENDS_BEARER_TOKEN}`,
          'x-guest-token': guestToken,
          'x-csrf-token': cookies.ct0,
          cookie: `ct0=${cookies.ct0}; auth_token=${cookies.authToken}`,
        },
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(
          `Failed to fetch trends: HTTP ${response.status}${body ? ` - ${body}` : ''}`,
        )
      }

      const trends = parseTrendNames((await response.json()) as GuideJsonResponse)
      if (trends.length === 0) {
        throw new Error('No trend entries found.')
      }
      return trends
    },
  }
}
