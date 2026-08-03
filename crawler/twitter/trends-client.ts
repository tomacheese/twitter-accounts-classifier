import type { IssuedCookies } from 'twitter-client'
import type { TrendsScraperLike } from './timeline'

// `@the-convocation/twitter-scraper` の getTrends() は同じ bearer token・エンドポイントを叩くが、
// その実装では bearer token を override として渡すと guest token を付与しないため、
// guide.json が認証エラーで拒否してしまう。
// アップストリームのライブラリ側に修正がない状態のため、
// このリクエストを自前で実装し直し、
// guest token を確実に付与するようにしている。
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
 * @param fetchImpl - リクエストを発行する fetch 実装
 * @returns 有効化した guest token
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
 * @param payload - パースした `guide.json` レスポンス本文
 * @returns 見つかったトレンド名の配列。空配列は形状は一致しトレンド項目が 0 件だったことを意味する
 * @throws レスポンス形状自体が想定と異なる場合。
 * スキーマ変更による破壊的失敗と「トレンド 0 件」という正常ケースを呼び出し側が混同しないよう、
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
 * @param cookies - アカウントの ct0・auth_token クッキーペア
 * @param fetchImpl - fetch 実装 (例: Chrome TLS フィンガープリントの cycletls fetch)
 * @returns `getTrends()` を公開するオブジェクト
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
