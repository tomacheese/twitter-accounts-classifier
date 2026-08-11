import { TwitterOpenApi, type TwitterOpenApiClient } from 'twitter-openapi-typescript'
import initCycleTLS, { type CycleTLSClient } from 'cycletls'
import type { IssuedCookies } from './cookie-issuer-client'
import { createTrendsClient } from './trends-client'
import type { TrendsScraperLike } from './api-types'
import { wrapFetchWithResponseCapture } from './response-capture'
import { createBlocksClient, createBlock, type BlocksListRawApiLike } from './blocks-client'
import { withTimeout } from './timeout'

const CHROME_JA3 =
  '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0'
const CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'

interface OpenApiFactory {
  getClientFromCookies(cookies: Record<string, string>): Promise<TwitterOpenApiClient>
}

/**
 * ネットワークに実際に到達する `TwitterOpenApi` クラスをテストで直接使わずに済むよう、
 * {@link createOpenApiClient} からこの部分だけを切り出し、
 * テストではフェイクな factory を注入できるようにしている。
 * @param factory - `getClientFromCookies` の実装。通常 `TwitterOpenApi` のインスタンス
 * @param cookies - Twitter アカウントに対して発行されたクッキー
 * @returns 認証済みの `TwitterOpenApiClient`
 */
export async function createOpenApiClientWith(
  factory: OpenApiFactory,
  cookies: IssuedCookies,
): Promise<TwitterOpenApiClient> {
  return factory.getClientFromCookies({
    ct0: cookies.ct0,
    auth_token: cookies.authToken,
  })
}

/** {@link createCycleTLSFetch} が Node 側リクエスト timeout に使う既定値。 */
export const DEFAULT_CYCLETLS_REQUEST_TIMEOUT_MS = 60_000

/**
 * X の GraphQL エンドポイントは Node 標準 `fetch` を Cloudflare に拒否される (HTTP 403) ため、
 * legacy trends エンドポイントと同様、
 * `cycletls` で本物の Chrome TLS/JA3 フィンガープリントを提示する `fetch` 実装を用意し、
 * {@link createTrendsScraper} と {@link createOpenApiClient} の双方で共有している。
 * `cycletls` 自体の内部 timeout (既定 20 秒) は Node↔Go 間の接続確立にのみ適用され、
 * 確立済み接続でのリクエスト自体には効かないため、`timeoutMs` で Node 側にも上限を設ける。
 * @param cycleTLS - 初期化済みの `cycletls` クライアント
 * @param timeoutMs - 1 リクエストあたりの Node 側上限時間 (ミリ秒)。既定 {@link DEFAULT_CYCLETLS_REQUEST_TIMEOUT_MS}
 * @returns `cycleTLS` 経由でリクエストを送る `fetch` 互換の関数
 */
export function createCycleTLSFetch(
  cycleTLS: CycleTLSClient,
  timeoutMs: number = DEFAULT_CYCLETLS_REQUEST_TIMEOUT_MS,
): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = (init?.method ?? 'GET').toLowerCase() as
      'get' | 'post' | 'put' | 'delete' | 'head' | 'options' | 'patch'
    const response = await withTimeout(
      cycleTLS(
        url,
        {
          body: typeof init?.body === 'string' ? init.body : undefined,
          headers: (init?.headers as Record<string, string> | undefined) ?? {},
          ja3: CHROME_JA3,
          userAgent: CHROME_USER_AGENT,
        },
        method,
      ),
      timeoutMs,
      `cycletls request to ${url} did not complete within ${timeoutMs}ms`,
    )
    return new Response(
      typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
      { status: response.status, headers: new Headers(response.headers) },
    )
  }
}

export interface OpenApiClientContext {
  client: TwitterOpenApiClient
  cycleTLS: CycleTLSClient
  blocksClient: BlocksListRawApiLike
  createBlock: (targetUserId: string) => Promise<void>
}

/**
 * Node の既定の `fetch` フィンガープリントは Cloudflare のボット検知でブロックされるため、
 * `cycletls` の Chrome フィンガープリント fetch ({@link createCycleTLSFetch}) を経由させている。
 * また、ライブラリ内部でパースに失敗すると生レスポンスが失われてしまうため、
 * {@link wrapFetchWithResponseCapture} でラップして事後に復元できるようにしている。
 * @param cookies - Twitter アカウントに対して発行されたクッキー
 * @param timeoutMs - {@link createCycleTLSFetch} に渡す 1 リクエストあたりの上限時間 (ミリ秒)
 * @param port - `cycletls` の Go バイナリが listen する port。省略時は `cycletls` 既定値 (9119)
 * @returns クライアントと、依存する `cycletls` クライアント。呼び出し側でクローズできるように返す
 */
export async function createOpenApiClient(
  cookies: IssuedCookies,
  timeoutMs: number = DEFAULT_CYCLETLS_REQUEST_TIMEOUT_MS,
  port?: number,
): Promise<OpenApiClientContext> {
  const cycleTLS = await initCycleTLS(port === undefined ? undefined : { port })
  try {
    const fetchImpl = wrapFetchWithResponseCapture(createCycleTLSFetch(cycleTLS, timeoutMs))
    TwitterOpenApi.fetchApi = fetchImpl
    const client = await createOpenApiClientWith(new TwitterOpenApi(), cookies)
    const blocksClient = createBlocksClient(cookies, fetchImpl)
    return {
      client,
      cycleTLS,
      blocksClient,
      createBlock: (targetUserId: string) => createBlock(cookies, fetchImpl, targetUserId),
    }
  } catch (error) {
    // ここで throw すると呼び出し元は cycleTLS を受け取れず close できないため、
    // 返す前に自分で close する。
    await cycleTLS.exit()
    throw error
  }
}

/**
 * OpenAPI クライアントが依存する `cycletls` クライアントを解放する。
 * クライアントが不要になった時点で必ず呼び出さないと、
 * 内部の `cycletls` プロセスがリークする。
 * @param context - {@link createOpenApiClient} が返したコンテキスト
 */
export async function closeOpenApiClient(context: OpenApiClientContext): Promise<void> {
  await context.cycleTLS.exit()
}

export interface TrendsScraperContext {
  scraper: TrendsScraperLike
  cycleTLS: CycleTLSClient
}

/**
 * 自前の trends クライアント ({@link createTrendsClient} 参照) を、
 * Chrome TLS/JA3 を提示する `cycletls` fetch で動く {@link TrendsScraperLike} を作る。
 * {@link createOpenApiClient} と同じ診断上の理由から、
 * {@link wrapFetchWithResponseCapture} でもラップしている。
 * @param cookies - Twitter アカウントに対して発行されたクッキー
 * @param timeoutMs - {@link createCycleTLSFetch} に渡す 1 リクエストあたりの上限時間 (ミリ秒)
 * @param port - `cycletls` の Go バイナリが listen する port。省略時は `cycletls` 既定値 (9119)
 * @returns スクレイパーと、依存する `cycletls` クライアント。呼び出し側でクローズできるように返す
 */
export async function createTrendsScraper(
  cookies: IssuedCookies,
  timeoutMs: number = DEFAULT_CYCLETLS_REQUEST_TIMEOUT_MS,
  port?: number,
): Promise<TrendsScraperContext> {
  const cycleTLS = await initCycleTLS(port === undefined ? undefined : { port })
  const scraper = createTrendsClient(
    cookies,
    wrapFetchWithResponseCapture(createCycleTLSFetch(cycleTLS, timeoutMs)),
  )

  return { scraper, cycleTLS }
}

/**
 * トレンドスクレイパーが依存する `cycletls` クライアントを解放する。
 * スクレイパーが不要になった時点で必ず呼び出さないと、
 * 内部の `cycletls` プロセスがリークする。
 * @param context - {@link createTrendsScraper} が返したコンテキスト
 */
export async function closeTrendsScraper(context: TrendsScraperContext): Promise<void> {
  await context.cycleTLS.exit()
}
