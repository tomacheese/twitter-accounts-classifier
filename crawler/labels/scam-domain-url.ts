import type { ScamDomainIndicator } from './scam-domains'
import { SCAM_DOMAIN_INDICATORS } from './scam-domains'

export interface ScamDomainEvidence {
  host: string
  indicator: ScamDomainIndicator
}

function isHostOrSubdomain(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`)
}

/** 管理対象の詐欺悪用ドメイン indicator に一致する URL 証拠だけを返す。 */
export function classifyScamDomainUrl(value: string): ScamDomainEvidence | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null

  const host = url.hostname.toLowerCase()
  const indicator = SCAM_DOMAIN_INDICATORS.find((entry) => isHostOrSubdomain(host, entry.domain))
  if (!indicator) return null

  return { host, indicator }
}
