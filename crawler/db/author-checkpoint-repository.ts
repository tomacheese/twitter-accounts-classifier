import { Logger } from '@book000/node-utils'
import { mergeTweetAdFlags } from 'twitter-client'
import type { PrismaClient, Tweet } from '../generated/prisma'
import type { LabelRuleRegistry } from '../labels/registry'
import type { buildDuplicateReplyIndex } from '../labels/duplicate-reply-index'
import type { buildReplyHijackIndex } from '../labels/reply-hijack-index'
import type { FollowGraphLabelIndex } from '../labels/follow-graph-label-index'
import { buildAccountFeatureBundle } from '../labels/build-account-feature-bundle'
import type { FollowListResult } from '../twitter/follows'
import { upsertAccount, type AccountProfileInput } from './account-repository'
import { upsertTweet, findTweetTextsByIds, type TweetInput } from './tweet-repository'
import {
  upsertFollowSampleAuthors,
  replaceLabelingFollowSampleWithinTx,
} from './labeling-follow-sample-repository'
import { recordCrawlAccountLabelsAtomicWithinTx } from './label-repository'
import { upsertReplyHijackEvidence } from './reply-hijack-evidence-repository'
import {
  recordCrawlAuthorCheckpoint,
  type CrawlWarning,
  type FollowSampleStatus,
} from './crawl-run-repository'

const logger = Logger.configure('author-checkpoint-repository')

export interface PersistAuthorResultAtomicParams {
  crawlRunId: string
  username: string
  authorId: string
  profile: AccountProfileInput
  /** `fetchRecentTweets` が返す Tweet 全件 (author 自身の Tweet と文脈 Tweet の両方)。 */
  recentTweets: TweetInput[]
  recentTweetsFetchedAt?: Date
  /**
   * authorId 自身の Tweet であることが確定しており、
   * fallback profile 解決が不要な追加分(timeline 上で観測された自身の投稿・他アカウント処理中に見つかった自身のリプライ)。
   * これらも同一 transaction 内で merge・評価し、
   * ラベル評価が merge 前の値を見る状態を避ける。
   */
  additionalOwnTweets: TweetInput[]
  /** `recentTweets` に含まれる文脈 Tweet の `accountId` FK を満たすための fallback profile。 */
  recentTweetsFallbackAuthors: AccountProfileInput[]
  /** remote fetch に失敗した場合は null。null の場合サンプル書き込みは skip する。 */
  followSample: FollowListResult | null
  followSampleStatus?: FollowSampleStatus
  followSampleRequestCount?: number
  followSampleRateLimitRemaining?: number | null
  followSampleRateLimitReset?: number | null
  parentTweetFetchRequestCount?: number
  parentTweetFetchRateLimitRemaining?: number | null
  parentTweetFetchRateLimitReset?: number | null
  registry: LabelRuleRegistry
  labelDefinitionIds: Map<string, string>
  duplicateReplyIndex: ReturnType<typeof buildDuplicateReplyIndex>
  replyHijackIndex: ReturnType<typeof buildReplyHijackIndex>
  followGraphLabelIndex: FollowGraphLabelIndex
  warnings: CrawlWarning[]
  durationMs: number
  retryWaitMs: number
  appVersion: string
}

export interface PersistAuthorResultAtomicResult {
  observationId: string | null
  labelsAppliedCount: number
}

/**
 * 1 author 分のローカル副作用 (Account profile・recent tweets・labeling follow sample・label 評価・author checkpoint) を 1 つの transaction にまとめて記録する。
 * remote fetch はこの関数の呼び出し前に完了している前提であり、ここでは行わない。
 * ラベル評価は upsertAccount/upsertTweet が返す merge 後の値を使って行う。
 * fetch 直後の生データを直接評価すると、
 * DB 側が既存の強い evidence を merge で保持していてもその cycle の評価だけ弱い値を見て陰性に戻ることがあるため。
 * labeling follow sample の remote fetch 失敗は non-fatal として扱うため、
 * `followSample` が null であれば該当の書き込みのみ skip し、checkpoint は通常どおり 'success' で記録する。
 * @param prisma - Prisma クライアント
 * @param params - author 1 件分の永続化対象
 * @returns ラベル claim が成功していれば作成した observation の id、全 claim 空振りなら null。および今回永続化したラベル件数
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
  const dedupedTweets = mergeTweetAdFlags([...params.recentTweets, ...params.additionalOwnTweets])

  return prisma.$transaction(
    async (tx) => {
      const txClient = tx as unknown as PrismaClient

      const { account: accountBeforeFetchStatusUpdate } = await upsertAccount(
        txClient,
        params.profile,
      )
      // `upsertAccount` の戻り値は `recentTweetsFetchStatus: 'success'` を反映する前の状態のため、
      // 以降のラベル評価には必ず update 後の戻り値を使う。
      const account = await txClient.account.update({
        where: { id: accountBeforeFetchStatusUpdate.id },
        data: {
          lastRecentTweetsAttemptedAt: params.recentTweetsFetchedAt ?? new Date(),
          lastRecentTweetsFetchedAt: params.recentTweetsFetchedAt ?? new Date(),
          recentTweetsFetchStatus: 'success',
        },
      })
      // `recentTweets` には他者に帰属する会話コンテキストの Tweet が混在するため、
      // Tweet.accountId の FK を満たすには対応する Account を先に用意しておく必要がある。
      for (const fallbackAuthor of fallbackAuthorsById.values()) {
        if (fallbackAuthor.id === params.profile.id) continue
        await upsertAccount(txClient, fallbackAuthor)
      }
      // `upsertTweets` の 1 件ずつ握り潰すエラー処理は、Postgres の transaction 内では機能しない。
      // 1 文が失敗すると transaction 全体が abort 状態になり、後続の全文が意味不明なエラーで失敗するため、
      // ここでは個別に呼んでエラーをそのまま伝播させる。
      const upsertedTweets: Tweet[] = []
      for (const tweet of dedupedTweets) {
        const { tweet: upserted } = await upsertTweet(txClient, tweet)
        upsertedTweets.push(upserted)
      }

      if (followeeIds.length > 0) {
        await replaceLabelingFollowSampleWithinTx(txClient, params.authorId, followeeIds)
      }

      const parentTweetTextById = new Map(
        upsertedTweets
          .filter((tweet) => tweet.accountId !== params.authorId)
          .map((tweet) => [tweet.id, tweet.fullText]),
      )
      const authorOwnTweets = upsertedTweets.filter((tweet) => tweet.accountId === params.authorId)
      // parent が今回の crawl で fetch されなかった (`findMissingTweetIds` が既存 DB 行と判定した) リプライは、
      // `upsertedTweets` に現れないため上記の in-memory map だけでは解決できない。
      // 未解決分だけ DB から補うことで、crawl 経路と relabel-worker 経路の評価結果を一致させる。
      const missingParentIds = [
        ...new Set(
          authorOwnTweets
            .map((tweet) => tweet.inReplyToTweetId)
            .filter((id): id is string => id !== null && !parentTweetTextById.has(id)),
        ),
      ]
      if (missingParentIds.length > 0) {
        const dbParentTweetTextById = await findTweetTextsByIds(txClient, missingParentIds)
        for (const [id, text] of dbParentTweetTextById) parentTweetTextById.set(id, text)
      }
      const bundle = buildAccountFeatureBundle(
        account,
        authorOwnTweets,
        params.duplicateReplyIndex,
        params.replyHijackIndex,
        params.followGraphLabelIndex,
        parentTweetTextById,
      )
      const appliedRules = params.registry.applyAll(bundle)
      const ruleResults = appliedRules.flatMap(({ rule, result }) => {
        const labelDefinitionId = params.labelDefinitionIds.get(rule.key)
        if (!labelDefinitionId) {
          logger.warn(`No LabelDefinition id found for rule "${rule.key}", skipping persistence`)
          return []
        }
        return [{ labelDefinitionId, result, method: rule.key, ruleVersion: rule.version }]
      })
      const positiveReplyHijackRule = appliedRules.find(
        ({ rule, result }) => rule.key === 'reply_hijack_swarm' && result.value,
      )

      const observationId = await recordCrawlAccountLabelsAtomicWithinTx(txClient, {
        accountId: params.profile.id,
        crawlRunId: params.crawlRunId,
        username: params.username,
        labels: ruleResults,
      })
      if (observationId !== null && positiveReplyHijackRule && bundle.replyHijackEvidence) {
        await upsertReplyHijackEvidence(txClient, {
          accountId: params.profile.id,
          ruleVersion: positiveReplyHijackRule.rule.version,
          ...bundle.replyHijackEvidence,
        })
      }
      const labelsAppliedCount = observationId === null ? 0 : ruleResults.length

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
        followSampleStatus: params.followSampleStatus ?? null,
        followSampleRequestCount: params.followSampleRequestCount ?? 0,
        followSampleRateLimitRemaining: params.followSampleRateLimitRemaining ?? null,
        followSampleRateLimitReset: params.followSampleRateLimitReset ?? null,
        parentTweetFetchRequestCount: params.parentTweetFetchRequestCount ?? 0,
        parentTweetFetchRateLimitRemaining: params.parentTweetFetchRateLimitRemaining ?? null,
        parentTweetFetchRateLimitReset: params.parentTweetFetchRateLimitReset ?? null,
        appVersion: params.appVersion,
      })

      return { observationId, labelsAppliedCount }
    },
    // 1 author 分の profile・tweets・follow sample・label 評価・checkpoint をまとめて書き込むため、
    // 単独の書き込みより往復回数が多い。
    // 既存の 15 秒予算はより小さな transaction 向けに設定された値のため、ここでは伸ばしておく。
    { maxWait: 30_000, timeout: 30_000 },
  )
}
