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

  const host = url.hostname.toLowerCase()
  if (isHostOrSubdomain(host, 'amzn.to')) {
    return { kind: 'associates-short-link', host }
  }

  if (!isAmazonRetailHost(host)) return null

  const tag = url.searchParams.get('tag')?.trim()
  if (!tag) return null

  return { kind: 'associate-tag', host, tag }
}
