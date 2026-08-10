/**
 * 管理対象の詐欺悪用ドメイン indicator。
 * `sourceReportedRisk` は外部で報告された悪用率の文字列表記であり、
 * 独立検証されていないため `LabelRuleResult.confidence` には変換しない。
 */
export interface ScamDomainIndicator {
  /** 判定対象のドメイン（ホスト名の完全一致・サブドメイン一致に使う）。 */
  domain: string
  /** 外部で報告された悪用率・悪用傾向の文字列表記（例: '95%', 'near 100%'）。 */
  sourceReportedRisk: string
  /** このドメインを indicator リストへ追加した年月（例: '2026-08'）。 */
  addedAt: string
}

export const SCAM_DOMAIN_INDICATORS: ScamDomainIndicator[] = [
  { domain: '1link.jp', sourceReportedRisk: '95%', addedAt: '2026-08' },
  { domain: 'link-card.online', sourceReportedRisk: 'near 100%', addedAt: '2026-08' },
  { domain: 'shorta.vip', sourceReportedRisk: 'near 100%', addedAt: '2026-08' },
  { domain: 'effectivegatecpm.com', sourceReportedRisk: 'near 100%', addedAt: '2026-08' },
  { domain: 'mavrtracktor.com', sourceReportedRisk: 'near 100%', addedAt: '2026-08' },
  { domain: 'b-short.link', sourceReportedRisk: 'near 100%', addedAt: '2026-08' },
  { domain: 'to-link.click', sourceReportedRisk: 'near 100%', addedAt: '2026-08' },
  { domain: 'cdn-videy.space', sourceReportedRisk: '80%+', addedAt: '2026-08' },
  { domain: 'cdn-videy.fit', sourceReportedRisk: '80%+', addedAt: '2026-08' },
  { domain: 'video.twimg.one', sourceReportedRisk: 'near 100%', addedAt: '2026-08' },
  { domain: 'ey43.com', sourceReportedRisk: 'near 100%', addedAt: '2026-08' },
]
