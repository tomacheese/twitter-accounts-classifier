import { TwitterOpenApi, type TwitterOpenApiClient } from 'twitter-openapi-typescript'
import initCycleTLS, { type CycleTLSClient } from 'cycletls'
import type { IssuedCookies } from '../auth/cookie-issuer-client'
import { createTrendsClient } from './trends-client'
import type { TrendsScraperLike } from './timeline'
import { wrapFetchWithResponseCapture } from './response-capture'

const CHROME_JA3 =
  '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0'
const CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'

interface OpenApiFactory {
  getClientFromCookies(cookies: Record<string, string>): Promise<TwitterOpenApiClient>
}

/**
 * Obtains an authenticated client from the given factory.
 * Split out from {@link createOpenApiClient} so tests can inject a fake factory instead
 * of constructing the real `TwitterOpenApi` class, which reaches out to the network.
 * @param factory - object exposing `getClientFromCookies`, typically a `TwitterOpenApi` instance
 * @param cookies - cookies issued for the Twitter account
 * @returns an authenticated `TwitterOpenApiClient`
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

/**
 * Builds a `fetch` implementation backed by `cycletls`, presenting a genuine Chrome
 * TLS/JA3 fingerprint instead of Node's default `fetch` fingerprint. Shared by
 * {@link createTrendsScraper} and {@link createOpenApiClient}, since X's real GraphQL
 * endpoints reject Node's default fingerprint with a Cloudflare block (HTTP 403), just
 * as the legacy trends endpoint does.
 * @param cycleTLS - an initialized `cycletls` client
 * @returns a `fetch`-compatible function routing requests through `cycleTLS`
 */
export function createCycleTLSFetch(cycleTLS: CycleTLSClient): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = (init?.method ?? 'GET').toLowerCase() as
      'get' | 'post' | 'put' | 'delete' | 'head' | 'options' | 'patch'
    const response = await cycleTLS(
      url,
      {
        body: typeof init?.body === 'string' ? init.body : undefined,
        headers: (init?.headers as Record<string, string> | undefined) ?? {},
        ja3: CHROME_JA3,
        userAgent: CHROME_USER_AGENT,
      },
      method,
    )
    return new Response(
      typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
      { status: response.status },
    )
  }
}

export interface OpenApiClientContext {
  client: TwitterOpenApiClient
  cycleTLS: CycleTLSClient
}

/**
 * Creates an authenticated `twitter-openapi-typescript` client from issued cookies,
 * routed through a `cycletls`-backed Chrome-fingerprinted fetch (see
 * {@link createCycleTLSFetch}) so GraphQL requests aren't blocked by Cloudflare's
 * bot-detection challenge, which Node's default `fetch` fingerprint triggers. Also
 * wrapped with {@link wrapFetchWithResponseCapture} so a raw response can still be
 * recovered after a parse failure inside the library, which otherwise discards it.
 * @param cookies - cookies issued for the Twitter account
 * @returns the client together with the `cycletls` client it depends on, so callers can close it
 */
export async function createOpenApiClient(cookies: IssuedCookies): Promise<OpenApiClientContext> {
  const cycleTLS = await initCycleTLS()
  TwitterOpenApi.fetchApi = wrapFetchWithResponseCapture(createCycleTLSFetch(cycleTLS))
  const client = await createOpenApiClientWith(new TwitterOpenApi(), cookies)
  return { client, cycleTLS }
}

/**
 * Releases the `cycletls` client backing an OpenAPI client. Must be called once the
 * client is no longer needed, otherwise the underlying `cycletls` process leaks.
 * @param context - the context returned by {@link createOpenApiClient}
 */
export async function closeOpenApiClient(context: OpenApiClientContext): Promise<void> {
  await context.cycleTLS.exit()
}

export interface TrendsScraperContext {
  scraper: TrendsScraperLike
  cycleTLS: CycleTLSClient
}

/**
 * Creates a {@link TrendsScraperLike} backed by our own trends client (see
 * {@link createTrendsClient}), routed through a `cycletls`-backed Chrome-fingerprinted
 * fetch so requests present a genuine Chrome TLS/JA3 fingerprint instead of Node's
 * default `fetch` fingerprint. Also wrapped with {@link wrapFetchWithResponseCapture},
 * for the same diagnostic reason as {@link createOpenApiClient}.
 * @param cookies - cookies issued for the Twitter account
 * @returns the scraper together with the `cycletls` client it depends on, so callers can close it
 */
export async function createTrendsScraper(cookies: IssuedCookies): Promise<TrendsScraperContext> {
  const cycleTLS = await initCycleTLS()
  const scraper = createTrendsClient(
    cookies,
    wrapFetchWithResponseCapture(createCycleTLSFetch(cycleTLS)),
  )

  return { scraper, cycleTLS }
}

/**
 * Releases the `cycletls` client backing a trends scraper. Must be called once the
 * scraper is no longer needed, otherwise the underlying `cycletls` process leaks.
 * @param context - the context returned by {@link createTrendsScraper}
 */
export async function closeTrendsScraper(context: TrendsScraperContext): Promise<void> {
  await context.cycleTLS.exit()
}
