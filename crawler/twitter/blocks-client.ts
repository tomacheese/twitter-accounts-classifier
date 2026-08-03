import { TwitterOpenApi } from 'twitter-openapi-typescript'
import type { IssuedCookies } from '../auth/cookie-issuer-client'
import type { RawUserResult } from './mappers'

/**
 * "BlockedAccountsAll" 操作の GraphQL persisted query id。`twitter-openapi-typescript` には
 * このエンドポイントに対応するメソッドが存在しないため、id・名前は X の配信済み Web クライアント
 * バンドルを直接読み、実際に一度認証済みリクエストを送って確認した。
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
 * `BlockedAccountsAll` の Timeline レスポンスに含まれる、正規化前のユーザーエントリの形。
 * `twitter-openapi-typescript` を経由しないリクエストなので、JSON はライブラリの camelCase な
 * `TweetApiUtilsData['user']` ではなく X の実際の snake_case ワイヤーフォーマットのまま届く。
 * `rest_id` は任意: 凍結・削除済みのブロック対象アカウントは `rest_id` を持たない
 * `UserUnavailable` 結果として返ってくるが、オブジェクト自体は truthy のまま届く。
 */
interface RawTimelineUser {
  rest_id?: string
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

/**
 * Timeline エントリ 1 件分の形。`content.itemContent` は、このエンドポイントの実レスポンスで
 * 実際に観測した 2 つの形をどちらもカバーする: ユーザー行 (`user_results`)、または末尾カーソルが
 * 独立した top-level エントリではなく `TimelineTimelineItem` の中に入れ子で届く場合。
 */
interface RawTimelineEntry {
  entryId: string
  content: {
    entryType: string
    itemContent?: {
      itemType?: string
      user_results?: { result?: RawTimelineUser }
      cursorType?: string
      value?: string
    }
    cursorType?: string
    value?: string
  }
}

/**
 * Timeline instruction 1 件分の形。`entry` (単数) は `TimelineReplaceEntry` をカバーするための
 * フィールドで、一部の instruction 種別は複数形の `entries` 配列の代わりにこちらを使う。
 */
interface RawTimelineInstruction {
  entries?: RawTimelineEntry[]
  entry?: RawTimelineEntry
}

interface BlockedAccountsAllResponse {
  errors?: { message?: string }[]
  data?: {
    viewer?: {
      timeline?: { timeline?: { instructions?: RawTimelineInstruction[] } }
    }
  }
}

/**
 * `BlockedAccountsAll` の生の Timeline ユーザーエントリを `./mappers` が期待する
 * `RawUserResult` の形に変換する。`./timeline.ts` の `toRawUserResult` を踏襲しつつ、
 * snake_case のワイヤーフォーマットを直接読むように調整している ({@link RawTimelineUser}
 * 直前の注記を参照)。screen_name/name/created_at は `core` が `legacy` より優先されるが、
 * `description` に対応する `core` フィールドは存在しないため `profile_bio` -> `legacy` の順で
 * フォールバックする。
 * @param user - `rest_id` を持つことが確認済みの、レスポンス内の 1 ユーザーエントリ
 * @returns `RawUserResult` の形に変換した同じユーザー
 */
function toRawUserResult(user: RawTimelineUser & { rest_id: string }): RawUserResult {
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
 * ひとつの Timeline instruction が持つ entry 群を返す。複数件なら配列の `entries`、
 * 単一件なら `entry` (`TimelineReplaceEntry` など) と、instruction によってフィールド名が
 * 異なるため、この違いを吸収する。
 * @param instruction - 対象の Timeline instruction
 * @returns instruction が持つ entry の一覧 (0 件のこともある)
 */
function entriesOf(instruction: RawTimelineInstruction): RawTimelineEntry[] {
  return [...(instruction.entries ?? []), ...(instruction.entry ? [instruction.entry] : [])]
}

/**
 * `BlockedAccountsAll` のレスポンスボディを {@link BlocksListPage} に変換する。
 * `./follows.ts` が `twitter-openapi-typescript` の正規化済みオブジェクト経由で読んでいるのと
 * 同じ Timeline instruction/entries/cursor の形を、ここでは生の JSON から直接読む。
 * @param payload - パース済みのレスポンスボディ
 * @returns 変換済みユーザー一覧と、次ページのカーソル (あれば)
 * @throws payload に GraphQL レベルのエラーが含まれる場合、またはレスポンスの形が想定と
 * まったく一致しない場合 (X 側のスキーマ変更など) - 「このページにブロックが 0 件」という
 * 正当な空配列と、スキーマ崩壊による破損とを呼び出し側が取り違えないよう区別している
 */
function parseBlocksResponse(payload: BlockedAccountsAllResponse): BlocksListPage {
  if (payload.errors && payload.errors.length > 0) {
    throw new Error(
      `BlockedAccountsAll response carried GraphQL errors: ${payload.errors
        .map((graphqlError) => graphqlError.message ?? 'unknown error')
        .join('; ')}`,
    )
  }

  const instructions = payload.data?.viewer?.timeline?.timeline?.instructions
  if (instructions === undefined) {
    throw new Error('Unexpected BlockedAccountsAll response shape: missing timeline instructions')
  }

  const users: RawUserResult[] = []
  let nextCursor: string | undefined

  for (const instruction of instructions) {
    for (const entry of entriesOf(instruction)) {
      const content = entry.content
      if (content.entryType === 'TimelineTimelineItem') {
        const item = content.itemContent
        if (item?.itemType === 'TimelineTimelineCursor' && item.cursorType === 'Bottom') {
          nextCursor = item.value
          continue
        }
        const user = item?.user_results?.result
        if (user?.rest_id)
          users.push(toRawUserResult(user as RawTimelineUser & { rest_id: string }))
      } else if (
        content.entryType === 'TimelineTimelineCursor' &&
        content.cursorType === 'Bottom'
      ) {
        nextCursor = content.value
      }
    }
  }

  return { users, nextCursor }
}

/**
 * blocks エンドポイントが非 2xx を返した際に throw するエラー。`twitter-openapi-typescript`
 * 自身の `ResponseError` の形 (`.name` と `.response.status`) を模倣することで、`./retry.ts` の
 * `isRetryableTwitterError` によるダックタイピングが、ライブラリが投げるエラーと同様に
 * このハンドロールしたリクエストのレート制限・サーバーエラーも retryable と認識できるようにする。
 */
class BlocksResponseError extends Error {
  response: { status: number }
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ResponseError'
    this.response = { status }
  }
}

/**
 * `twitter-openapi-typescript` にはブロック一覧エンドポイントに対応するメソッドが存在しないため、
 * `trends-client.ts` が `guide.json` をハンドロールしているのと同じ要領で GraphQL リクエストを
 * 自前で組み立てる。注意: ライブラリ自身の GraphQL リクエストと異なり、ここでは
 * `x-client-transaction-id` を付与していない (ライブラリ内部では `x-client-transaction-id-generater`
 * パッケージが、実際の Web クライアントの document を使って鍵を導出して生成している) -
 * 対応するには一行では済まない追加調査が必要なため、不要と決めつけず既知のギャップとして残す。
 * @param cookies - アカウントの ct0/auth_token クッキー
 * @param fetchImpl - リクエスト送信に使う fetch 実装 (`trends-client.ts` と同様、
 * cycleTLS による Chrome フィンガープリントを想定)
 * @returns `getBlocksPage` を公開するオブジェクト
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
          'x-twitter-auth-type': 'OAuth2Session',
          'x-twitter-active-user': 'yes',
          'x-twitter-client-language': 'en',
          referer: 'https://x.com/',
        },
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new BlocksResponseError(
          `Failed to fetch blocked users: HTTP ${response.status}${body ? ` - ${body}` : ''}`,
          response.status,
        )
      }

      const payload = (await response.json()) as BlockedAccountsAllResponse
      return parseBlocksResponse(payload)
    },
  }
}
