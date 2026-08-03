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
// crawler/db/client.ts は connection_limit を明示しないため、
// Prisma のデフォルトプールサイズ(num_physical_cpus * 2 + 1) に従う。
// 過去のプール枯渇を踏まえ、8 はそれに対して余裕を残せる値として選んでいる。
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
 * 各 (account, rule) ペアの直近の ruleVersion を取得する。
 * `AccountLabel` は追記のみで更新されないため、
 * この集計なしには最新ラベルが現在のルールバージョンを反映済みかどうか判別できない。
 * @param prisma - 問い合わせに使う Prisma クライアント
 * @returns `${accountId}:${labelDefinitionId}` から最新の ruleVersion へのマップ
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
 * `accountIds` それぞれについて、直近 `limitPerAccount` 件のツイートを1回のクエリで取得する。
 * Prisma のクエリビルダーではアカウントごとに1クエリを発行しない限り、
 * 「アカウントごとの上位 N 件」を表現できないため、`ROW_NUMBER()` を使った生 SQL で取得している。
 * @param prisma - 問い合わせに使う Prisma クライアント
 * @param accountIds - ツイートを取得する対象アカウント
 * @param limitPerAccount - アカウントごとに保持する直近ツイート件数
 * @returns アカウント ID から、そのアカウントの直近ツイート (新しい順) へのマップ
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
 * アカウント行と取得済みツイートから、ラベルルールが評価する `AccountFeatureBundle` を組み立てる。
 * 通常のクロール時 (`runCrawlCycle`) が作る形と同一にすることで、
 * ルールがクロール実行時とこの再評価バックフィルとで異なる挙動にならないようにしている。
 * @param account - バンドルを組み立てる対象アカウント
 * @param recentTweets - 取得済みの、このアカウントの直近ツイート
 * @param duplicateReplyIndex - アカウント横断で共有する重複返信インデックス
 * @param replyHijackIndex - アカウント横断で共有するリプライハイジャック群インデックス
 * @returns アカウントの feature bundle
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
 * @param account - 判定対象のアカウント
 * @param rules - 登録済みの全ルール
 * @param labelDefinitionIds - ルールキーから LabelDefinition の id へのマップ
 * @param latestRuleVersions - アカウント・ルールの組ごとに直近で永続化された ruleVersion
 * @returns 登録済みの全ルールについて、このアカウントのバージョンが既に最新であれば true (この場合、ツイートを取得せずスキップできる)
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
 * 登録済みの全ラベルルールを全アカウントに対して再評価し、
 * 保存済み `ruleVersion` が古いか未評価の (account, rule) ペアについてのみ新しい `AccountLabel` 行を永続化する。
 * 通常のクロールでは対象アカウントが次に再クロールされるまでラベルは再評価されない (ルールのロジック変更に対する自動再評価はない) ため、
 * そのギャップをオンデマンドで埋める明示的なバックフィル処理。
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
   * 前回ログ出力からの処理済みアカウント数が `progressLogIntervalAccounts` を超えたタイミングで、
   * 累計進捗・直近区間の処理速度・残り時間の概算を1行ログ出力する。
   * 経過時間が MIN_ELAPSED_MINUTES_FOR_RATE 未満の場合は、
   * ゼロ除算や桁溢れした速度値を出力しないよう速度算出をスキップし、件数のみ出力する。
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

    // ここで空のツイートサンプルからラベルを永続化すると、
    // このページの全 stale アカウントの latestRuleVersions が現在のルールバージョンに更新され、
    // isFullyUpToDate に最新とみなされて再評価されなくなる。
    // 永続化をスキップして stale なまま残し、次回実行で再取得・再評価させる。
    // accountsProcessed には試行済みとしてカウントするため、
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

// このモジュールを import しただけ (relabel.test.ts からの import など) では実際のバックフィルが走らないようにするガード。
// 直接実行 (`node dist/relabel.js`)した場合のみ動作する。require/module は、
// CommonJS を採用する本プロジェクトでこれを判定するのに適した手段である。
// eslint-disable-next-line unicorn/prefer-module
if (require.main === module) {
  initMonitoring()
  main().catch((error: unknown) => {
    logger.error('Relabel backfill failed', error as Error)
    captureException(error)
    process.exitCode = 1
  })
}
