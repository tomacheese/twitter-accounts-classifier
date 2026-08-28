import { PrismaClient } from '../generated/prisma'
import { loadSelfReplyPromoCorpus } from '../db/self-reply-promo-corpus'
import { buildSelfReplyPromoIndex } from '../labels/self-reply-promo-index'
import { buildAccountFeatureBundle } from '../labels/build-account-feature-bundle'
import { buildDuplicateReplyIndex } from '../labels/duplicate-reply-index'
import { buildBioDuplicateIndex } from '../labels/bio-duplicate-index'
import { buildReplyHijackIndex } from '../labels/reply-hijack-index'
import { selfReplyPromoChainRule } from '../labels/rules/self-reply-promo-chain'
import { CRAWL_LIMITS } from '../config/crawl-limits'

const BACKTEST_ACCOUNT_LIMIT = Number(process.env.BACKTEST_ACCOUNT_LIMIT ?? 500)

const emptyFollowGraphLabelIndex = { signalsFor: () => ({}) }

/**
 * self-reply promo chain の候補があるアカウント (index に evidence を持つアカウント) の id 一覧。
 * @param selfReplyPromoAccountIds - コーパスから抽出した候補アカウント id
 * @returns 該当アカウント id (最大 `BACKTEST_ACCOUNT_LIMIT` 件)
 */
function loadCandidateAccountIds(selfReplyPromoAccountIds: string[]): string[] {
  return selfReplyPromoAccountIds.slice(0, BACKTEST_ACCOUNT_LIMIT)
}

async function main(): Promise<void> {
  const prisma = new PrismaClient()
  try {
    const watermark = new Date()
    console.log('Loading self-reply promo corpus...')
    const { selfReplyCorpus, rootCorpus } = await loadSelfReplyPromoCorpus(prisma, watermark)
    const selfReplyPromoIndex = buildSelfReplyPromoIndex(selfReplyCorpus, rootCorpus)

    const selfReplyPromoAccountIds = [...new Set(selfReplyCorpus.map((entry) => entry.accountId))]
    const candidateAccountIds = loadCandidateAccountIds(selfReplyPromoAccountIds)
    console.log(`Evaluating ${candidateAccountIds.length} candidate accounts...`)

    const accounts = await prisma.account.findMany({ where: { id: { in: candidateAccountIds } } })
    let positiveCount = 0

    for (const account of accounts) {
      const recentTweets = await prisma.tweet.findMany({
        where: { accountId: account.id },
        orderBy: { createdAt: 'desc' },
        take: CRAWL_LIMITS.recentTweetsPerAccount,
      })
      const parentTweetIds = [
        ...new Set(
          recentTweets
            .map((tweet) => tweet.inReplyToTweetId)
            .filter((id): id is string => id !== null),
        ),
      ]
      const parentTweets = await prisma.tweet.findMany({
        where: { id: { in: parentTweetIds } },
        select: { id: true, fullText: true },
      })
      const parentTweetTextById = new Map(parentTweets.map((tweet) => [tweet.id, tweet.fullText]))

      const bundle = buildAccountFeatureBundle(
        account,
        recentTweets,
        buildDuplicateReplyIndex([]),
        buildBioDuplicateIndex([]),
        buildReplyHijackIndex([]),
        emptyFollowGraphLabelIndex,
        selfReplyPromoIndex,
        parentTweetTextById,
      )

      const result = selfReplyPromoChainRule.evaluate(bundle)
      if (!result.value) continue
      positiveCount += 1
      console.log(`[positive] ${account.screenName} (${account.id}): ${result.reason}`)
    }

    console.log(
      `Backtest complete: ${positiveCount} / ${accounts.length} candidate accounts evaluated positive`,
    )
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

// 実行手順:
// DATABASE_URL=<read replica 等の接続文字列> \
//   pnpm --filter crawler exec tsx scripts/self-reply-promo-chain-backtest.ts
// BACKTEST_ACCOUNT_LIMIT で評価対象アカウント数の上限を調整できる (既定 500)。
// AccountLabel/AccountLabelLatest への書き込みは一切行わない。
