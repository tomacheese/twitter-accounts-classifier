export type AmazonAffiliateEvidence =
  | { kind: 'associate-tag'; host: string; tag: string }
  | { kind: 'associates-short-link'; host: string }

const AMAZON_RETAIL_DOMAINS = new Set([
  'amazon.co.jp',
  'amazon.com',
  'amazon.co.uk',
  'amazon.ca',
  'amazon.de',
  'amazon.fr',
  'amazon.it',
  'amazon.es',
  'amazon.in',
  'amazon.com.au',
  'amazon.com.br',
  'amazon.com.mx',
  'amazon.nl',
  'amazon.se',
  'amazon.pl',
  'amazon.sg',
  'amazon.ae',
  'amazon.sa',
  'amazon.com.be',
])

function isHostOrSubdomain(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`)
}

function isAmazonRetailHost(host: string): boolean {
  return [...AMAZON_RETAIL_DOMAINS].some((base) => isHostOrSubdomain(host, base))
}

/** Amazon Associates 由来と高い確度で判断できる URL 証拠だけを返す。 */
export function classifyAmazonAffiliateUrl(value: string): AmazonAffiliateEvidence | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null

  // 末尾ドット付きの FQDN でも判定をすり抜けないよう取り除く。
  const host = url.hostname.toLowerCase().replace(/\.$/u, '')
  // amzn.to は短縮後に tag が見えないため、他の Amazon ドメインと異なり tag クエリの有無を条件にしていない。
  // 一般ユーザーの商品共有でも使われるため、陽性にする条件は呼び出し側のルールで絞る。
  // amzn.asia・a.co・link.amazon はアプリの共有リンク等でも発行され、Associates 由来を判別できないため対象外とする。
  if (isHostOrSubdomain(host, 'amzn.to')) {
    return { kind: 'associates-short-link', host }
  }

  if (!isAmazonRetailHost(host)) return null

  const tag = url.searchParams.get('tag')?.trim()
  if (!tag) return null

  return { kind: 'associate-tag', host, tag }
}
