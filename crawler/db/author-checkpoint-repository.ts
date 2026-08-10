import { mergeTweetAdFlags } from 'twitter-client'
import type { PrismaClient } from '../generated/prisma'
import type { LabelRuleResult } from '../labels/types'
import type { FollowListResult } from '../twitter/follows'
import { upsertAccount, type AccountProfileInput } from './account-repository'
import { upsertTweet, type TweetInput } from './tweet-repository'
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
 * 1 author 分のローカル副作用 (Account profile・recent tweets・labeling follow sample・label 評価・author checkpoint) を 1 つの transaction にまとめて記録する。
 * remote fetch はこの関数の呼び出し前に完了している前提であり、ここでは行わない。
 * labeling follow sample の remote fetch 失敗は non-fatal として扱うため、
 * `followSample` が null であれば該当の書き込みのみ skip し、checkpoint は通常どおり 'success' で記録する。
 * @param prisma - Prisma クライアント
 * @param params - author 1 件分の永続化対象
 * @returns ラベル claim が成功していれば作成した observation の id、全 claim 空振りなら null
 */
export async function persistAuthorResultAtomic(
  prisma: PrismaClient,
  params: PersistAuthorResultAtomicParams,
): Promise<PersistAuthorResultAtomicResult> {
  // label・observation は profile.id を account として記録し、checkpoint は authorId を key にする。
  // 両者が食い違うと、別の account に label が付いたまま authorId が完了済みとして skip され続けるため、ここで検出する。
  if (params.profile.id !== params.authorId) {
    throw new Error(
      `Author id mismatch: fetched profile id ${params.profile.id} does not match requested authorId ${params.authorId}`,
    )
  }

  let followeeIds: string[] = []
  if (params.followSample) {
    const upsertedIds = await upsertFollowSampleAuthors(prisma, params.followSample)
    followeeIds = params.followSample.ids.filter((id) => upsertedIds.has(id))
  }

  // `fetchRecentTweets` は tweets と同数の author を返すため、同一人物への言及が複数回あると重複する。
  // 重複したまま upsert すると transaction 内の往復回数が不要に増えるため、1 author 1 回に統合する。
  const fallbackAuthorsById = new Map(
    params.recentTweetsFallbackAuthors.map((author) => [author.id, author]),
  )
  const dedupedRecentTweets = mergeTweetAdFlags(params.recentTweets)

  return prisma.$transaction(
    async (tx) => {
      const txClient = tx as unknown as PrismaClient

      await upsertAccount(txClient, params.profile)
      // `recentTweets` には他者に帰属する会話コンテキストの Tweet が混在するため、
      // Tweet.accountId の FK を満たすには対応する Account を先に用意しておく必要がある。
      for (const fallbackAuthor of fallbackAuthorsById.values()) {
        if (fallbackAuthor.id === params.profile.id) continue
        await upsertAccount(txClient, fallbackAuthor)
      }
      // `upsertTweets` の 1 件ずつ握り潰すエラー処理は、Postgres の transaction 内では機能しない。
      // 1 文が失敗すると transaction 全体が abort 状態になり、後続の全文が意味不明なエラーで失敗するため、
      // ここでは個別に呼んでエラーをそのまま伝播させる。
      for (const tweet of dedupedRecentTweets) {
        await upsertTweet(txClient, tweet)
      }

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
    // 1 author 分の profile・tweets・follow sample・label 評価・checkpoint をまとめて
    // 書き込むため、単独の書き込みより往復回数が多い。既存の 15 秒予算は
    // より小さな transaction 向けに設定された値のため、ここでは伸ばしておく。
    { maxWait: 30_000, timeout: 30_000 },
  )
}
