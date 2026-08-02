import { Logger } from '@book000/node-utils'
import { captureException, initMonitoring } from './monitoring/sentry'
import type { PrismaClient } from './generated/prisma'
import { getPrismaClient, disconnectPrisma } from './db/client'
import { ensureLabelDefinitionsForRules, recordAccountLabelsBulk } from './db/label-repository'
import { loadReplyCorpus } from './db/reply-corpus'
import { LabelRuleRegistry } from './labels/registry'
import { ALL_LABEL_RULES } from './labels/all-rules'
import { CRAWL_LIMITS } from './config/crawl-limits'
import { buildDuplicateReplyIndex } from './labels/duplicate-reply-index'
import { buildReplyHijackIndex } from './labels/reply-hijack-index'
import { runWithConcurrencyLimit } from './utils/concurrency-limit'
import type { AccountFeatureBundle, LabelRule, LabelRuleResult } from './labels/types'

const logger = Logger.configure('relabel')

const ACCOUNT_BATCH_SIZE = 100
// crawler/db/client.ts は connection_limit を明示しないため、Prisma のデフォルトプールサイズ
// (num_physical_cpus * 2 + 1) に従う。過去のプール枯渇 (commit 3fa6cd3) を踏まえ、
// 8 はそれに対して十分な余裕を残す値として選んだ。
const ACCOUNT_CONCURRENCY = 8
const PROGRESS_LOG_INTERVAL = 1000
// これ未満の経過時間では速度算出がゼロ除算に近くなり異常値になるため、算出をスキップする閾値。
const MIN_ELAPSED_MINUTES_FOR_RATE = 1 / 60_000

export interface RelabelOptions {
  /** 進捗ログを出力する処理済みアカウント数の間隔 (省略時は `PROGRESS_LOG_INTERVAL`)。 */
  progressLogIntervalAccounts?: number
}

interface LatestLabelRow {
  accountId: string
  labelDefinitionId: string
  ruleVersion: string
}

/**
 * Loads each (account, rule) pair's most recently recorded `ruleVersion`.
 * `AccountLabel` rows are append-only (see `recordAccountLabel`), so this is
 * how the backfill tells a pair that already reflects the rule's current
 * version apart from one that is stale or has never been labeled.
 * @param prisma - the Prisma client to query
 * @returns a map from `${accountId}:${labelDefinitionId}` to its latest ruleVersion
 */
async function loadLatestRuleVersions(prisma: PrismaClient): Promise<Map<string, string>> {
  const rows = await prisma.$queryRaw<LatestLabelRow[]>`
    SELECT DISTINCT ON ("accountId", "labelDefinitionId")
      "accountId", "labelDefinitionId", "ruleVersion"
    FROM "AccountLabel"
    ORDER BY "accountId", "labelDefinitionId", "labeledAt" DESC, "id" DESC
  `
  return new Map(rows.map((row) => [`${row.accountId}:${row.labelDefinitionId}`, row.ruleVersion]))
}

interface AccountRow {
  id: string
  screenName: string
  displayName: string
  bio: string | null
  followersCount: number
  followingCount: number
  tweetCount: number
  accountCreatedAt: Date
  isBlueVerified: boolean
  verifiedType: string | null
  professionalType: string | null
  parodyCommentaryFanLabel: string | null
}

interface TweetRow {
  id: string
  fullText: string
  createdAt: Date
  retweetCount: number
  likeCount: number
  isReply: boolean
  isRetweet: boolean
  isPromoted: boolean
  isPaidPromotion: boolean
  foreignVideoSourceCount: number | null
  inReplyToTweetId: string | null
  quotedTweetAuthorId: string | null
  quotedTweetHasVideo: boolean | null
  accountId: string
}

/**
 * Fetches the top `limitPerAccount` most recent tweets for each of `accountIds` in a
 * single query, using `ROW_NUMBER() OVER (PARTITION BY "accountId" ORDER BY "createdAt"
 * DESC)` to express the same "top N per account" semantics Prisma's query builder cannot
 * do directly without one query per account.
 * @param prisma - the Prisma client to query
 * @param accountIds - the accounts to fetch tweets for
 * @param limitPerAccount - how many of each account's most recent tweets to keep
 * @returns a map from accountId to that account's top tweets, most recent first
 */
async function fetchTweetsForAccounts(
  prisma: PrismaClient,
  accountIds: string[],
  limitPerAccount: number,
): Promise<Map<string, TweetRow[]>> {
  const byAccount = new Map<string, TweetRow[]>()
  if (accountIds.length === 0) return byAccount

  const rows = await prisma.$queryRaw<TweetRow[]>`
    SELECT id, "fullText", "createdAt", "retweetCount", "likeCount", "isReply",
           "isRetweet", "isPromoted", "isPaidPromotion", "inReplyToTweetId",
           "quotedTweetAuthorId", "quotedTweetHasVideo", "foreignVideoSourceCount", "accountId"
    FROM (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY "accountId" ORDER BY "createdAt" DESC
      ) AS rn
      FROM "Tweet"
      WHERE "accountId" = ANY(${accountIds})
    ) ranked
    WHERE rn <= ${limitPerAccount}
    ORDER BY "accountId", "createdAt" DESC
  `
  for (const row of rows) {
    const existing = byAccount.get(row.accountId) ?? []
    existing.push(row)
    byAccount.set(row.accountId, existing)
  }
  return byAccount
}

/**
 * Builds the `AccountFeatureBundle` a label rule evaluates, from the given account row
 * plus its already-fetched tweets — the same shape `runCrawlCycle` builds live, so a rule
 * behaves identically whether it runs during a crawl or during this backfill.
 * @param account - the account to build a bundle for
 * @param recentTweets - this account's most recent tweets, already fetched
 * @param duplicateReplyIndex - the shared cross-account duplicate-reply index
 * @param replyHijackIndex - the shared cross-account reply-hijack-swarm index
 * @returns the account's feature bundle
 */
function buildFeatureBundle(
  account: AccountRow,
  recentTweets: TweetRow[],
  duplicateReplyIndex: ReturnType<typeof buildDuplicateReplyIndex>,
  replyHijackIndex: ReturnType<typeof buildReplyHijackIndex>,
): AccountFeatureBundle {
  let templatedReplyNetworkSize = 0
  let replyHijackSwarmSize = 0
  for (const tweet of recentTweets) {
    if (!tweet.isReply) continue
    templatedReplyNetworkSize = Math.max(
      templatedReplyNetworkSize,
      duplicateReplyIndex.countOtherAccounts(tweet.fullText, account.id),
    )
    if (tweet.inReplyToTweetId !== null) {
      replyHijackSwarmSize = Math.max(
        replyHijackSwarmSize,
        replyHijackIndex.swarmSizeFor(account.id, tweet.inReplyToTweetId),
      )
    }
  }

  return {
    account,
    recentTweets: recentTweets.map((tweet) => ({
      id: tweet.id,
      fullText: tweet.fullText,
      createdAt: tweet.createdAt,
      retweetCount: tweet.retweetCount,
      likeCount: tweet.likeCount,
      isReply: tweet.isReply,
      isRetweet: tweet.isRetweet,
      isPromoted: tweet.isPromoted,
      isPaidPromotion: tweet.isPaidPromotion,
      foreignVideoSourceCount: tweet.foreignVideoSourceCount,
      inReplyToTweetId: tweet.inReplyToTweetId,
      quotedTweetAuthorId: tweet.quotedTweetAuthorId,
      quotedTweetHasVideo: tweet.quotedTweetHasVideo,
    })),
    templatedReplyNetworkSize,
    replyHijackSwarmSize,
  }
}

export interface RelabelResult {
  accountsProcessed: number
  labelsPersisted: number
}

/**
 * @param account - the account to check
 * @param rules - every registered rule
 * @param labelDefinitionIds - rule key to LabelDefinition id
 * @param latestRuleVersions - the account/rule pair's most recently persisted ruleVersion
 * @returns true if every registered rule's version is already current for this account,
 *   meaning it can be skipped without fetching its tweets at all
 */
function isFullyUpToDate(
  account: AccountRow,
  rules: LabelRule[],
  labelDefinitionIds: Map<string, string>,
  latestRuleVersions: Map<string, string>,
): boolean {
  return rules.every((rule) => {
    const labelDefinitionId = labelDefinitionIds.get(rule.key)
    if (!labelDefinitionId) return false
    return latestRuleVersions.get(`${account.id}:${labelDefinitionId}`) === rule.version
  })
}

/**
 * 登録済みの全ラベルルールを全アカウントに対して再評価し、保存済み `ruleVersion` が
 * 古いか未評価の (account, rule) ペアについてのみ新しい `AccountLabel` 行を永続化する。
 * 通常のクロールでは対象アカウントが次に再クロールされるまでラベルは再評価されない
 * (ルールのロジック変更に対する自動再評価はない) ため、そのギャップをオンデマンドで
 * 埋める明示的なバックフィル処理。
 * @param prisma - 使用する Prisma クライアント
 * @param registry - 全アカウントに対して評価するラベルルールのレジストリ
 * @param options - 任意の上書き設定 (例: 進捗ログの出力間隔)
 * @returns 処理したアカウント数と (再) 永続化したラベル数
 */
export async function runRelabelBackfill(
  prisma: PrismaClient,
  registry: LabelRuleRegistry,
  options: RelabelOptions = {},
): Promise<RelabelResult> {
  const progressLogIntervalAccounts = options.progressLogIntervalAccounts ?? PROGRESS_LOG_INTERVAL
  const totalAccounts = await prisma.account.count()
  const labelDefinitionIds = await ensureLabelDefinitionsForRules(prisma, registry.getAll())
  const latestRuleVersions = await loadLatestRuleVersions(prisma)
  const replyCorpus = await loadReplyCorpus(prisma)
  const duplicateReplyIndex = buildDuplicateReplyIndex(replyCorpus)
  const replyHijackIndex = buildReplyHijackIndex(replyCorpus)

  let accountsProcessed = 0
  let labelsPersisted = 0
  let cursor: string | undefined
  let lastLoggedAccountsProcessed = 0
  let lastLoggedAt = Date.now()

  /**
   * 前回ログ出力からの処理済みアカウント数が `progressLogIntervalAccounts` を超えた
   * タイミングで、累計進捗・直近区間の処理速度・残り時間の概算を1行ログ出力する。
   * 経過時間が MIN_ELAPSED_MINUTES_FOR_RATE 未満の場合は、ゼロ除算や桁溢れした
   * 速度値を出力しないよう速度算出をスキップし、件数のみ出力する。
   */
  function logProgressIfDue(): void {
    const processedSinceLastLog = accountsProcessed - lastLoggedAccountsProcessed
    if (processedSinceLastLog < progressLogIntervalAccounts) return

    const now = Date.now()
    const elapsedMinutes = (now - lastLoggedAt) / 60_000
    let rateMessage = ''
    if (elapsedMinutes > MIN_ELAPSED_MINUTES_FOR_RATE) {
      const accountsPerMinute = processedSinceLastLog / elapsedMinutes
      const remainingAccounts = totalAccounts - accountsProcessed
      const etaMinutes =
        accountsPerMinute > 0 ? Math.round(remainingAccounts / accountsPerMinute) : undefined
      rateMessage = `, ${accountsPerMinute.toFixed(1)} accounts/min (recent), ETA ${etaMinutes ?? 'unknown'} min`
    }
    logger.info(
      `Relabel progress: ${accountsProcessed}/${totalAccounts} accounts processed, ${labelsPersisted} labels persisted${rateMessage}`,
    )
    lastLoggedAccountsProcessed = accountsProcessed
    lastLoggedAt = now
  }

  for (;;) {
    const accounts: AccountRow[] = await prisma.account.findMany({
      orderBy: { id: 'asc' },
      take: ACCOUNT_BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    })
    if (accounts.length === 0) break

    const rules = registry.getAll()
    const staleAccounts = accounts.filter(
      (account) => !isFullyUpToDate(account, rules, labelDefinitionIds, latestRuleVersions),
    )
    accountsProcessed += accounts.length - staleAccounts.length
    logProgressIfDue()

    let tweetsByAccount: Map<string, TweetRow[]>
    let tweetFetchFailed = false
    try {
      tweetsByAccount = await fetchTweetsForAccounts(
        prisma,
        staleAccounts.map((account) => account.id),
        CRAWL_LIMITS.recentTweetsPerAccount,
      )
    } catch (error) {
      logger.error(
        `Failed to fetch tweets for a batch of ${staleAccounts.length} accounts, skipping this page`,
        error as Error,
      )
      tweetsByAccount = new Map()
      tweetFetchFailed = true
    }

    // ここで空のツイートサンプルからラベルを永続化すると、このページの全 stale アカウントの
    // latestRuleVersions が現在のルールバージョンに更新され、isFullyUpToDate に最新と
    // みなされて再評価されなくなる。永続化をスキップして stale なまま残し、次回実行で
    // 再取得・再評価させる。accountsProcessed には試行済みとしてカウントするため、
    // フェッチ失敗時も進捗ログの分母が totalAccounts に到達する。
    if (tweetFetchFailed) {
      accountsProcessed += staleAccounts.length
      logProgressIfDue()
    } else {
      await runWithConcurrencyLimit(staleAccounts, ACCOUNT_CONCURRENCY, async (account) => {
        try {
          const bundle = buildFeatureBundle(
            account,
            tweetsByAccount.get(account.id) ?? [],
            duplicateReplyIndex,
            replyHijackIndex,
          )
          const labelsToPersist: {
            labelDefinitionId: string
            versionKey: string
            method: string
            ruleVersion: string
            result: LabelRuleResult
          }[] = []
          for (const { rule, result } of registry.applyAll(bundle)) {
            const labelDefinitionId = labelDefinitionIds.get(rule.key)
            if (!labelDefinitionId) {
              logger.warn(
                `No LabelDefinition id found for rule "${rule.key}", skipping persistence`,
              )
              continue
            }
            const versionKey = `${account.id}:${labelDefinitionId}`
            if (latestRuleVersions.get(versionKey) === rule.version) {
              continue
            }
            labelsToPersist.push({
              labelDefinitionId,
              versionKey,
              method: rule.key,
              ruleVersion: rule.version,
              result,
            })
          }
          if (labelsToPersist.length > 0) {
            await recordAccountLabelsBulk(prisma, {
              accountId: account.id,
              labels: labelsToPersist.map(({ labelDefinitionId, method, ruleVersion, result }) => ({
                labelDefinitionId,
                method,
                ruleVersion,
                result,
              })),
            })
            for (const { versionKey, ruleVersion } of labelsToPersist) {
              latestRuleVersions.set(versionKey, ruleVersion)
              labelsPersisted++
            }
          }
          accountsProcessed++
          logProgressIfDue()
        } catch (error) {
          logger.error(
            `Failed to relabel account ${account.id} (@${account.screenName}), skipping to next account`,
            error as Error,
          )
          // 失敗しても試行済みとしてカウントする (でなければ進捗ログの分母が totalAccounts に到達しない)
          accountsProcessed++
          logProgressIfDue()
        }
      })
    }

    if (accounts.length < ACCOUNT_BATCH_SIZE) break
    cursor = accounts.at(-1)?.id
  }

  return { accountsProcessed, labelsPersisted }
}

async function main(): Promise<void> {
  const prisma = getPrismaClient()
  const registry = new LabelRuleRegistry()
  for (const rule of ALL_LABEL_RULES) {
    registry.register(rule)
  }

  try {
    const { accountsProcessed, labelsPersisted } = await runRelabelBackfill(prisma, registry)
    logger.info(
      `Relabel backfill complete: ${accountsProcessed} accounts processed, ${labelsPersisted} labels persisted`,
    )
  } finally {
    await disconnectPrisma()
  }
}

// Guarded so importing this module (e.g. from relabel.test.ts) never triggers a real
// backfill run - only running it directly (`node dist/relabel.js`) does. require/module
// are the correct CommonJS-native way to detect this (project is CommonJS, not ESM).
// eslint-disable-next-line unicorn/prefer-module
if (require.main === module) {
  initMonitoring()
  main().catch((error: unknown) => {
    logger.error('Relabel backfill failed', error as Error)
    captureException(error)
    process.exitCode = 1
  })
}
