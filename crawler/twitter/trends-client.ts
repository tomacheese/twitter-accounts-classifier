import type { IssuedCookies } from '../auth/cookie-issuer-client'
import type { TrendsScraperLike } from './timeline'

// `@the-convocation/twitter-scraper` の getTrends() は同じ bearer token・
// エンドポイントを叩くが、その実装では bearer token を override として渡すと
// guest token を付与しないため、guide.json が認証エラーで拒否してしまう。
// アップストリームのライブラリ側に修正がない状態のため、このリクエストを自前で
// 実装し直し、guest token を確実に付与するようにしている。
const TRENDS_BEARER_TOKEN =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'

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
 * @param payload - the parsed `guide.json` response body
 * @returns the trend names found; an empty array means the response shape matched but
 * carried zero trend items
 * @throws レスポンス形状自体が想定と異なる場合。スキーマ変更による破壊的な失敗と
 * 「今トレンドが 0 件」という正常なケースを呼び出し側が混同しないよう、
 * 空配列を返す場合とは区別してエラーを投げる。
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
