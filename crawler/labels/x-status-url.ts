export interface XStatusUrlInfo {
  screenName: string
  statusId: string
  canonical: string
}

const X_STATUS_HOSTS = ['twitter.com', 'x.com']

// amazon-affiliate-url.ts・scam-domain-url.ts と同じ判定を、
// 依存を増やさずファイルごとに複製する既存の書き方に合わせている。
function isHostOrSubdomain(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`)
}

const STATUS_PATH_PATTERN = /^\/(\w+)\/status\/(\d+)/

/** x.com/twitter.com のツイート詳細 URL だけを、ID ベースの正規化キーへ変換する。 */
export function classifyXStatusUrl(value: string): XStatusUrlInfo | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null

  const host = url.hostname.toLowerCase()
  const isXHost = X_STATUS_HOSTS.some((base) => isHostOrSubdomain(host, base))
  if (!isXHost) return null

  const match = STATUS_PATH_PATTERN.exec(url.pathname)
  if (!match) return null
  const [, screenName, statusId] = match

  return { screenName, statusId, canonical: `x-status:${statusId}` }
}
