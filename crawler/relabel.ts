import { Logger } from '@book000/node-utils'
import { captureException, initMonitoring } from './monitoring/sentry'
import type { PrismaClient } from './generated/prisma'
import { getPrismaClient, disconnectPrisma } from './db/client'
import { ensureLabelDefinitionsForRules, recordAccountLabel } from './db/label-repository'
import { loadReplyCorpus } from './db/reply-corpus'
import { LabelRuleRegistry } from './labels/registry'
import { ALL_LABEL_RULES } from './labels/all-rules'
import { CRAWL_LIMITS } from './config/crawl-limits'
import { buildDuplicateReplyIndex } from './labels/duplicate-reply-index'
import { buildReplyHijackIndex } from './labels/reply-hijack-index'
import type { AccountFeatureBundle, LabelRule } from './labels/types'

const logger = Logger.configure('relabel')

const ACCOUNT_BATCH_SIZE = 100

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
  inReplyToTweetId: string | null
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
           "isRetweet", "isPromoted", "isPaidPromotion", "inReplyToTweetId", "accountId"
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
      inReplyToTweetId: tweet.inReplyToTweetId,
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
 * Re-evaluates every registered label rule against every account, persisting
 * a new `AccountLabel` row only for (account, rule) pairs whose stored
 * `ruleVersion` is stale or missing. Live crawling only re-evaluates an
 * account's labels the next time that account happens to be crawled again —
 * there is no automatic re-labeling when a rule's logic changes. This is the
 * explicit backfill that closes that gap on demand.
 * @param prisma - the Prisma client to use
 * @param registry - the label rule registry to evaluate against every account
 * @returns the number of accounts processed and labels (re)persisted
 */
export async function runRelabelBackfill(
  prisma: PrismaClient,
  registry: LabelRuleRegistry,
): Promise<RelabelResult> {
  const labelDefinitionIds = await ensureLabelDefinitionsForRules(prisma, registry.getAll())
  const latestRuleVersions = await loadLatestRuleVersions(prisma)
  const replyCorpus = await loadReplyCorpus(prisma)
  const duplicateReplyIndex = buildDuplicateReplyIndex(replyCorpus)
  const replyHijackIndex = buildReplyHijackIndex(replyCorpus)

  let accountsProcessed = 0
  let labelsPersisted = 0
  let cursor: string | undefined

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

    // Persisting labels built from an empty tweet sample here would set `latestRuleVersions`
    // to the current rule version for every stale account in this page, so `isFullyUpToDate`
    // would wrongly treat them as current on the next run and they'd never be re-evaluated
    // with real data. Skipping the persist loop entirely keeps them stale, so a future run
    // retries the fetch and relabels them properly once it succeeds.
    if (!tweetFetchFailed) {
      for (const account of staleAccounts) {
        try {
          const bundle = buildFeatureBundle(
            account,
            tweetsByAccount.get(account.id) ?? [],
            duplicateReplyIndex,
            replyHijackIndex,
          )
          for (const { rule, result } of registry.applyAll(bundle)) {
            const labelDefinitionId = labelDefinitionIds.get(rule.key)
            if (!labelDefinitionId) {
              logger.warn(`No LabelDefinition id found for rule "${rule.key}", skipping persistence`)
              continue
            }
            const versionKey = `${account.id}:${labelDefinitionId}`
            if (latestRuleVersions.get(versionKey) === rule.version) {
              continue
            }
            await recordAccountLabel(prisma, {
              accountId: account.id,
              labelDefinitionId,
              method: rule.key,
              ruleVersion: rule.version,
              result,
            })
            latestRuleVersions.set(versionKey, rule.version)
            labelsPersisted++
          }
          accountsProcessed++
        } catch (error) {
          logger.error(
            `Failed to relabel account ${account.id} (@${account.screenName}), skipping to next account`,
            error as Error,
          )
        }
      }
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
