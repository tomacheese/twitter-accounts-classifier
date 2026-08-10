import type { PrismaClient } from '../generated/prisma'
import type { LabelRuleResult } from '../labels/types'
import type { FollowListResult } from '../twitter/follows'
import { upsertAccount, type AccountProfileInput } from './account-repository'
import { upsertTweets, type TweetInput } from './tweet-repository'
import {
  upsertFollowSampleAuthors,
  replaceLabelingFollowSampleWithinTx,
} from './labeling-follow-sample-repository'
import { recordCrawlAccountLabelsAtomicWithinTx } from './label-repository'
import { recordCrawlAuthorCheckpoint, type CrawlWarning } from './crawl-run-repository'

export interface PersistAuthorResultAtomicParams {
  crawlRunId: string
  username: string
  authorId: string
  profile: AccountProfileInput
  /** `fetchRecentTweets` が返す Tweet 全件 (author 自身の Tweet と文脈 Tweet の両方)。 */
  recentTweets: TweetInput[]
  /** `recentTweets` に含まれる文脈 Tweet の `accountId` FK を満たすための fallback profile。 */
  recentTweetsFallbackAuthors: AccountProfileInput[]
  /** remote fetch に失敗した場合は null。null の場合サンプル書き込みは skip する。 */
  followSample: FollowListResult | null
  labels: {
    labelDefinitionId: string
    result: LabelRuleResult
    method: string
    ruleVersion: string
  }[]
  warnings: CrawlWarning[]
  durationMs: number
  retryWaitMs: number
  appVersion: string
}

export interface PersistAuthorResultAtomicResult {
  observationId: string | null
}

/**
 * 1 author 分のローカル副作用 (Account profile・recent tweets・labeling follow sample・
 * label 評価・author checkpoint) を 1 つの transaction にまとめて記録する。
 * remote fetch はこの関数の呼び出し前に完了している前提であり、ここでは行わない。
 * labeling follow sample の remote fetch 失敗は non-fatal として扱うため、
 * `followSample` が null であれば該当の書き込みだけを skip し、
 * 残りの永続化・checkpoint 記録 (status は変更しない) は通常どおり行う。
 * @param prisma - Prisma クライアント
 * @param params - author 1 件分の永続化対象
 * @returns ラベル claim が成功していれば作成した observation の id、全 claim 空振りなら null
 */
export async function persistAuthorResultAtomic(
  prisma: PrismaClient,
  params: PersistAuthorResultAtomicParams,
): Promise<PersistAuthorResultAtomicResult> {
  let followeeIds: string[] = []
  if (params.followSample) {
    const upsertedIds = await upsertFollowSampleAuthors(prisma, params.followSample)
    followeeIds = params.followSample.ids.filter((id) => upsertedIds.has(id))
  }

  return prisma.$transaction(
    async (tx) => {
      const txClient = tx as unknown as PrismaClient

      await upsertAccount(txClient, params.profile)
      // `recentTweets` には他者に帰属する会話コンテキストの Tweet が混在するため、
      // Tweet.accountId の FK を満たすには対応する Account を先に用意しておく必要がある。
      for (const fallbackAuthor of params.recentTweetsFallbackAuthors) {
        if (fallbackAuthor.id === params.profile.id) continue
        await upsertAccount(txClient, fallbackAuthor)
      }
      await upsertTweets(txClient, params.recentTweets)

      if (followeeIds.length > 0) {
        await replaceLabelingFollowSampleWithinTx(txClient, params.authorId, followeeIds)
      }

      const observationId = await recordCrawlAccountLabelsAtomicWithinTx(txClient, {
        accountId: params.profile.id,
        crawlRunId: params.crawlRunId,
        username: params.username,
        labels: params.labels,
      })
      const labelsAppliedCount = observationId === null ? 0 : params.labels.length

      await recordCrawlAuthorCheckpoint(txClient, {
        crawlRunId: params.crawlRunId,
        username: params.username,
        authorId: params.authorId,
        status: 'success',
        profileCount: 1,
        labelsAppliedCount,
        warnings: params.warnings,
        durationMs: params.durationMs,
        retryWaitMs: params.retryWaitMs,
        appVersion: params.appVersion,
      })

      return { observationId }
    },
    { maxWait: 15_000, timeout: 15_000 },
  )
}
