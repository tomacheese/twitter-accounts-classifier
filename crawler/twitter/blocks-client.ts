import { TwitterOpenApi } from 'twitter-openapi-typescript'
import type { IssuedCookies } from '../auth/cookie-issuer-client'
import type { RawUserResult } from './mappers'

/**
 * GraphQL persisted query id for the "BlockedAccountsAll" operation. `twitter-openapi-typescript`
 * has no built-in method for this endpoint, so the id/name were confirmed by directly reading
 * X's shipped web client bundle (see docs/superpowers/plans/2026-08-03-blocks-endpoint-findings.md).
 */
const BLOCKS_QUERY_ID = '5oNXfRkE7HVkDX1Fd1gn3g'
const BLOCKS_OPERATION_NAME = 'BlockedAccountsAll'
const BLOCKS_ENDPOINT_URL = `https://x.com/i/api/graphql/${BLOCKS_QUERY_ID}/${BLOCKS_OPERATION_NAME}`

export interface BlocksListPage {
  users: RawUserResult[]
  nextCursor: string | undefined
}

export interface BlocksListRawApiLike {
  getBlocksPage(cursor: string | undefined, count: number): Promise<BlocksListPage>
}

/**
 * Raw (pre-normalization) shape of a user entry inside `BlockedAccountsAll`'s Timeline
 * response. This request bypasses `twitter-openapi-typescript`, so the JSON arrives in X's
 * actual snake_case wire format rather than the library's camelCase `TweetApiUtilsData['user']`.
 */
interface RawTimelineUser {
  rest_id: string
  core?: { screen_name?: string; name?: string; created_at?: string }
  legacy?: {
    screen_name?: string
    name?: string
    description?: string | null
    followers_count?: number
    friends_count?: number
    statuses_count?: number
    created_at?: string
    profile_image_url_https?: string | null
    location?: string | null
    url?: string | null
  }
  profile_bio?: { description?: string | null }
  is_blue_verified?: boolean
  verification?: { verified_type?: string | null }
  professional?: { professional_type?: string | null }
  parody_commentary_fan_label?: string | null
}

interface RawTimelineEntry {
  entryId: string
  content: {
    entryType: string
    itemContent?: { user_results?: { result?: RawTimelineUser } }
    cursorType?: string
    value?: string
  }
}

interface BlockedAccountsAllResponse {
  data?: {
    viewer?: {
      timeline?: { timeline?: { instructions?: { entries?: RawTimelineEntry[] }[] } }
    }
  }
}

/**
 * Converts one raw `BlockedAccountsAll` Timeline user entry into the `RawUserResult` shape
 * `./mappers` expects. Mirrors `./timeline.ts`'s `toRawUserResult`, adapted to read the
 * snake_case wire format directly (see the note above {@link RawTimelineUser}) - `core`
 * takes precedence over `legacy`/`profile_bio` the same way X's live responses do.
 * @param user - one raw user entry from the response
 * @returns the same user in the `RawUserResult` shape
 */
function toRawUserResult(user: RawTimelineUser): RawUserResult {
  return {
    restId: user.rest_id,
    legacy: {
      screenName: user.core?.screen_name ?? user.legacy?.screen_name ?? '',
      name: user.core?.name ?? user.legacy?.name ?? '',
      description: user.profile_bio?.description ?? user.legacy?.description ?? null,
      followersCount: user.legacy?.followers_count ?? 0,
      friendsCount: user.legacy?.friends_count ?? 0,
      statusesCount: user.legacy?.statuses_count ?? 0,
      createdAt: user.core?.created_at ?? user.legacy?.created_at ?? '',
      profileImageUrlHttps: user.legacy?.profile_image_url_https ?? null,
      location: user.legacy?.location ?? null,
      url: user.legacy?.url ?? null,
    },
    isBlueVerified: user.is_blue_verified ?? false,
    verifiedType: user.verification?.verified_type ?? null,
    professionalType: user.professional?.professional_type ?? null,
    parodyCommentaryFanLabel: user.parody_commentary_fan_label ?? null,
  }
}

/**
 * Parses a `BlockedAccountsAll` response body into a {@link BlocksListPage}, reading the
 * same Timeline-instruction/entries/cursor shape `./follows.ts` already reads via
 * `twitter-openapi-typescript`'s normalized objects, but directly off the raw JSON here.
 * @param payload - the parsed response body
 * @returns the mapped users plus the next-page cursor, if any
 */
function parseBlocksResponse(payload: BlockedAccountsAllResponse): BlocksListPage {
  const instructions = payload.data?.viewer?.timeline?.timeline?.instructions ?? []
  const users: RawUserResult[] = []
  let nextCursor: string | undefined

  for (const instruction of instructions) {
    for (const entry of instruction.entries ?? []) {
      if (entry.content.entryType === 'TimelineTimelineItem') {
        const user = entry.content.itemContent?.user_results?.result
        if (user) users.push(toRawUserResult(user))
      } else if (
        entry.content.entryType === 'TimelineTimelineCursor' &&
        entry.content.cursorType === 'Bottom'
      ) {
        nextCursor = entry.content.value
      }
    }
  }

  return { users, nextCursor }
}

/**
 * `twitter-openapi-typescript` has no built-in method for the blocks-list endpoint, so this
 * hand-rolls the GraphQL request the same way `trends-client.ts` hand-rolls `guide.json`.
 * @param cookies - the account's ct0/auth_token cookies
 * @param fetchImpl - fetch implementation to issue the request with (cycleTLS-backed Chrome
 * fingerprint expected, same as `trends-client.ts`)
 * @returns an object exposing `getBlocksPage`
 */
export function createBlocksClient(
  cookies: IssuedCookies,
  fetchImpl: typeof fetch,
): BlocksListRawApiLike {
  return {
    async getBlocksPage(cursor, count): Promise<BlocksListPage> {
      const variables: { count: number; cursor?: string } = { count }
      if (cursor) variables.cursor = cursor
      const params = new URLSearchParams({
        variables: JSON.stringify(variables),
        features: JSON.stringify({}),
      })

      const response = await fetchImpl(`${BLOCKS_ENDPOINT_URL}?${params.toString()}`, {
        headers: {
          authorization: `Bearer ${TwitterOpenApi.bearer}`,
          'x-csrf-token': cookies.ct0,
          cookie: `ct0=${cookies.ct0}; auth_token=${cookies.authToken}`,
        },
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(
          `Failed to fetch blocked users: HTTP ${response.status}${body ? ` - ${body}` : ''}`,
        )
      }

      const payload = (await response.json()) as BlockedAccountsAllResponse
      return parseBlocksResponse(payload)
    },
  }
}
