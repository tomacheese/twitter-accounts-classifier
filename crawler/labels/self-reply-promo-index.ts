import { classifyXStatusUrl } from './x-status-url'
import { normalizeSelfReplyPromoText } from './self-reply-promo-text'
import type { SelfReplyPromoCorpusEntry, RootCandidateEntry } from '../db/self-reply-promo-corpus'

export interface SelfReplyPromoEvidence {
  promoRoots: number
  exactDestinationRoots: number
  multiHopRoots: number
  maxChainDepth: number
}

export interface SelfReplyPromoIndex {
  evidenceFor(accountId: string): SelfReplyPromoEvidence | undefined
}

// self_reply_promo_chain ルールの Route A/B の閾値と揃える。
// 1 回だけの self-promo を positive にしないための下限である。
const MIN_ROOTS_FOR_CAMPAIGN = 3

interface QualifyingEdge {
  rootId: string
  depth: number
  canonicalXStatusId: string
  targetHandle: string
  normalizedText: string
}

/**
 * self-reply corpus と root 候補コーパスから、アカウント単位の self-reply promo chain evidence を構築する。
 * @param selfReplyCorpus - 自己返信コーパス
 * @param rootCorpus - self-reply チェーンを遡って解決した root 候補コーパス
 * @returns account 単位で問い合わせるためのインデックス
 */
export function buildSelfReplyPromoIndex(
  selfReplyCorpus: SelfReplyPromoCorpusEntry[],
  rootCorpus: RootCandidateEntry[],
): SelfReplyPromoIndex {
  const selfReplyById = new Map(selfReplyCorpus.map((entry) => [entry.id, entry]))
  const qualifyingRootIds = new Set(
    rootCorpus.filter((root) => !root.isReply && !root.isRetweet).map((root) => root.id),
  )

  const edgesByAccount = new Map<string, QualifyingEdge[]>()
  for (const entry of selfReplyCorpus) {
    for (const url of entry.expandedUrls) {
      const status = classifyXStatusUrl(url)
      if (!status) continue
      if (status.screenName.toLowerCase() === entry.authorScreenName.toLowerCase()) continue

      // root まで遡って depth を数える。他人の reply を挟む、または root に到達できない場合は除外する。
      let depth = 1
      let ancestorId: string | null = entry.inReplyToTweetId
      let reachedQualifyingRoot = false
      while (ancestorId !== null) {
        if (qualifyingRootIds.has(ancestorId)) {
          reachedQualifyingRoot = true
          break
        }
        const ancestor = selfReplyById.get(ancestorId)
        if (!ancestor) break
        depth += 1
        ancestorId = ancestor.inReplyToTweetId
      }
      if (!reachedQualifyingRoot || ancestorId === null) continue

      const edges = edgesByAccount.get(entry.accountId) ?? []
      edges.push({
        rootId: ancestorId,
        depth,
        canonicalXStatusId: status.canonical,
        targetHandle: status.screenName.toLowerCase(),
        normalizedText: normalizeSelfReplyPromoText(entry.fullText),
      })
      edgesByAccount.set(entry.accountId, edges)
    }
  }

  const evidenceByAccount = new Map<string, SelfReplyPromoEvidence>()
  for (const [accountId, edges] of edgesByAccount) {
    const rootsByDestination = new Map<string, Set<string>>()
    const rootsByCampaign = new Map<string, Set<string>>()
    let maxChainDepth = 0

    for (const edge of edges) {
      maxChainDepth = Math.max(maxChainDepth, edge.depth)

      const destinationRoots = rootsByDestination.get(edge.canonicalXStatusId) ?? new Set()
      destinationRoots.add(edge.rootId)
      rootsByDestination.set(edge.canonicalXStatusId, destinationRoots)

      if (edge.depth >= 2) {
        const campaignKey = `${edge.targetHandle}:${edge.normalizedText}`
        const campaignRoots = rootsByCampaign.get(campaignKey) ?? new Set()
        campaignRoots.add(edge.rootId)
        rootsByCampaign.set(campaignKey, campaignRoots)
      }
    }

    const destinationRootCounts = [...rootsByDestination.values()].map((roots) => roots.size)
    const exactDestinationRoots = destinationRootCounts.length > 0 ? Math.max(...destinationRootCounts) : 0
    const campaignRootCounts = [...rootsByCampaign.values()].map((roots) => roots.size)
    const multiHopRoots = campaignRootCounts.length > 0 ? Math.max(...campaignRootCounts) : 0

    const positiveRootIds = new Set<string>()
    if (exactDestinationRoots >= MIN_ROOTS_FOR_CAMPAIGN) {
      for (const roots of rootsByDestination.values()) for (const rootId of roots) positiveRootIds.add(rootId)
    }
    if (multiHopRoots >= MIN_ROOTS_FOR_CAMPAIGN) {
      for (const roots of rootsByCampaign.values()) for (const rootId of roots) positiveRootIds.add(rootId)
    }
    if (positiveRootIds.size === 0) continue

    evidenceByAccount.set(accountId, {
      promoRoots: positiveRootIds.size,
      exactDestinationRoots,
      multiHopRoots,
      maxChainDepth,
    })
  }

  return {
    evidenceFor(accountId) {
      return evidenceByAccount.get(accountId)
    },
  }
}
