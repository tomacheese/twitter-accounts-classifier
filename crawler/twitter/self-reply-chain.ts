import { getLastResponseMatching, getResponseErrorDiagnostics, toTweetInput } from 'twitter-client'
import type { TweetDetailApiLike } from './engagement'
import type { TweetDetailRateLimitBudget } from './tweet-detail-rate-limit-budget'
import type { TweetInput } from '../db/tweet-repository'

export interface FetchSelfReplyChainOptions {
  maxDepth: number
  maxNodesPerRoot: number
}

/**
 * `startNode` を起点に、同一著者による self-reply の子孫を再帰的に辿って取得する。
 * TweetDetail は focal tweet 直下の子ノードまでしか返さないため、
 * depth 2 以降を得るには self-reply 自身を focalTweetId として再度呼び出す必要がある。
 * @param client - ツイート詳細 API クライアント
 * @param budget - crawl cycle 全体で共有する TweetDetail レート制限予算
 * @param startNode - 起点となる self-reply、またはその親の root ツイート
 * @param options - 探索する深さ・1 root あたりの取得ノード数の上限
 * @returns 新たに取得した self-reply ノード (`startNode` 自身は含まない)
 */
export async function fetchSelfReplyChain(
  client: TweetDetailApiLike,
  budget: TweetDetailRateLimitBudget,
  startNode: TweetInput,
  options: FetchSelfReplyChainOptions,
): Promise<TweetInput[]> {
  const collected: TweetInput[] = []
  const visited = new Set<string>([startNode.id])
  let frontier: TweetInput[] = [startNode]
  let depth = 0

  while (frontier.length > 0 && depth < options.maxDepth) {
    const nextFrontier: TweetInput[] = []
    for (const node of frontier) {
      if (collected.length >= options.maxNodesPerRoot) return collected

      const decision = budget.acquireOptionalFetch()
      if (decision !== 'allowed') return collected

      let response: Awaited<ReturnType<TweetDetailApiLike['getTweetDetail']>>
      try {
        response = await client.getTweetDetail({ focalTweetId: node.id })
      } catch (error) {
        const diagnostics = getResponseErrorDiagnostics(error)
        if (diagnostics?.httpStatus === 429) budget.recordRateLimited(diagnostics)
        return collected
      }
      const captured = getLastResponseMatching('TweetDetail')
      budget.recordSuccess({
        rateLimitRemaining: captured?.rateLimitRemaining,
        rateLimitReset: captured?.rateLimitReset,
      })

      const children = response.data.data
        .filter((raw) => raw.legacy.inReplyToStatusIdStr === node.id)
        .map((raw) =>
          toTweetInput(raw, { source: node.source, viewerAccountId: startNode.accountId }),
        )
        .filter((child) => child.isAuthorReply && !visited.has(child.id))

      for (const child of children) {
        if (collected.length >= options.maxNodesPerRoot) break
        visited.add(child.id)
        collected.push(child)
        nextFrontier.push(child)
      }
    }
    frontier = nextFrontier
    depth += 1
  }

  return collected
}
