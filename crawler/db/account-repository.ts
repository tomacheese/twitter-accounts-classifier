import { Logger } from '@book000/node-utils'
import { Prisma, type Account, type PrismaClient } from '../generated/prisma'
import type { NormalizedAccountProfile } from 'twitter-client'

const logger = Logger.configure('account-repository')

export type AccountProfileInput = NormalizedAccountProfile

export async function upsertAccount(
  prisma: PrismaClient,
  input: AccountProfileInput,
): Promise<Account> {
  const now = new Date()
  return prisma.account.upsert({
    where: { id: input.id },
    create: {
      ...input,
      firstSeenAt: now,
      lastCrawledAt: now,
    },
    update: {
      screenName: input.screenName,
      displayName: input.displayName,
      bio: input.bio,
      profileImageUrl: input.profileImageUrl,
      followersCount: input.followersCount,
      followingCount: input.followingCount,
      tweetCount: input.tweetCount,
      location: input.location,
      url: input.url,
      isBlueVerified: input.isBlueVerified,
      verifiedType: input.verifiedType,
      professionalType: input.professionalType,
      parodyCommentaryFanLabel: input.parodyCommentaryFanLabel,
      lastCrawledAt: now,
    },
  })
}

interface UpsertAccountsBulkRow {
  id: string
}

// row-local (行内容に起因する決定的なエラー): NOT NULL 制約違反・チェック制約違反・型不一致等。
const ROW_LOCAL_SQLSTATE_PREFIXES = ['22', '23502', '23514']

// systemic (一時的・システム全体のエラー): 接続断・デッドロック・シリアライズ失敗等。
// このホワイトリストに載らない SQLSTATE は systemic 側として扱う (安全側に倒す)。
const SYSTEMIC_SQLSTATE_PREFIXES = ['08', '40001', '40P01']

/**
 * Prisma の raw query エラーから実際の Postgres SQLSTATE を抽出する。
 * raw query 失敗時、Prisma 6.19.3 の top-level `error.code` は Prisma 独自のラッパーコード
 * (`P2010`: "Raw query failed") になり、実際の SQLSTATE は `error.meta.code` に入る。
 * top-level コードをそのまま SQLSTATE と誤認しないよう、ここで明示的に抽出する。
 * @param error - `upsertAccountsBulk()` の raw query 呼び出しで発生した例外
 * @returns 抽出できた場合は SQLSTATE 文字列、できない場合は null
 */
function extractPostgresSqlState(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null
  const code = error.meta?.code
  return typeof code === 'string' ? code : null
}

function isRowLocalSqlState(sqlState: string): boolean {
  return ROW_LOCAL_SQLSTATE_PREFIXES.some((prefix) => sqlState.startsWith(prefix))
}

function isSystemicSqlState(sqlState: string): boolean {
  return SYSTEMIC_SQLSTATE_PREFIXES.some((prefix) => sqlState.startsWith(prefix))
}

/** 分割の再帰段数に上限を設け、想定外の無限再帰を防ぐ。 */
function maxBisectionDepth(batchSize: number): number {
  return Math.ceil(Math.log2(Math.max(batchSize, 1))) * 4
}

async function upsertAccountsBulkQuery(
  prisma: PrismaClient,
  rows: AccountProfileInput[],
): Promise<UpsertAccountsBulkRow[]> {
  const ids = rows.map((r) => r.id)
  const screenNames = rows.map((r) => r.screenName)
  const displayNames = rows.map((r) => r.displayName)
  const bios = rows.map((r) => r.bio)
  const profileImageUrls = rows.map((r) => r.profileImageUrl)
  const followersCounts = rows.map((r) => r.followersCount)
  const followingCounts = rows.map((r) => r.followingCount)
  const tweetCounts = rows.map((r) => r.tweetCount)
  const accountCreatedAts = rows.map((r) => r.accountCreatedAt)
  const locations = rows.map((r) => r.location)
  const urls = rows.map((r) => r.url)
  const isBlueVerifieds = rows.map((r) => r.isBlueVerified)
  const verifiedTypes = rows.map((r) => r.verifiedType)
  const professionalTypes = rows.map((r) => r.professionalType)
  const parodyCommentaryFanLabels = rows.map((r) => r.parodyCommentaryFanLabel)

  return prisma.$queryRaw<UpsertAccountsBulkRow[]>`
    WITH shared_now AS (
      SELECT now() AS "now"
    ),
    input_rows AS (
      SELECT * FROM UNNEST(
        ${ids}::text[], ${screenNames}::text[], ${displayNames}::text[], ${bios}::text[],
        ${profileImageUrls}::text[], ${followersCounts}::int[], ${followingCounts}::int[],
        ${tweetCounts}::int[], ${accountCreatedAts}::timestamptz[], ${locations}::text[],
        ${urls}::text[], ${isBlueVerifieds}::boolean[], ${verifiedTypes}::text[],
        ${professionalTypes}::text[], ${parodyCommentaryFanLabels}::text[]
      ) AS u(
        "id", "screenName", "displayName", "bio", "profileImageUrl", "followersCount",
        "followingCount", "tweetCount", "accountCreatedAt", "location", "url",
        "isBlueVerified", "verifiedType", "professionalType", "parodyCommentaryFanLabel"
      )
    )
    INSERT INTO "Account" (
      "id", "screenName", "displayName", "bio", "profileImageUrl", "followersCount",
      "followingCount", "tweetCount", "accountCreatedAt", "location", "url",
      "isBlueVerified", "verifiedType", "professionalType", "parodyCommentaryFanLabel",
      "firstSeenAt", "lastCrawledAt", "updatedAt"
    )
    SELECT
      ir.*, shared_now."now", shared_now."now", shared_now."now"
    FROM input_rows ir
    CROSS JOIN shared_now
    ON CONFLICT ("id") DO UPDATE SET
      "screenName" = EXCLUDED."screenName",
      "displayName" = EXCLUDED."displayName",
      "bio" = EXCLUDED."bio",
      "profileImageUrl" = EXCLUDED."profileImageUrl",
      "followersCount" = EXCLUDED."followersCount",
      "followingCount" = EXCLUDED."followingCount",
      "tweetCount" = EXCLUDED."tweetCount",
      "location" = EXCLUDED."location",
      "url" = EXCLUDED."url",
      "isBlueVerified" = EXCLUDED."isBlueVerified",
      "verifiedType" = EXCLUDED."verifiedType",
      "professionalType" = EXCLUDED."professionalType",
      "parodyCommentaryFanLabel" = EXCLUDED."parodyCommentaryFanLabel",
      "lastCrawledAt" = EXCLUDED."lastCrawledAt",
      "updatedAt" = EXCLUDED."updatedAt"
    RETURNING "id"
  `
}

async function upsertAccountsBulkWithBisection(
  prisma: PrismaClient,
  rows: AccountProfileInput[],
  depth: number,
): Promise<Set<string>> {
  if (rows.length === 0) return new Set()

  try {
    const result = await upsertAccountsBulkQuery(prisma, rows)
    return new Set(result.map((r) => r.id))
  } catch (error) {
    const sqlState = extractPostgresSqlState(error)
    const isRowLocal = sqlState !== null && isRowLocalSqlState(sqlState)
    const isSystemic = sqlState === null || !isRowLocal || isSystemicSqlState(sqlState)
    if (isSystemic) throw error

    if (rows.length === 1) {
      logger.error(`Skipping row-invalid account ${rows[0].id} in bulk upsert`, error as Error)
      return new Set()
    }
    if (depth >= maxBisectionDepth(rows.length)) {
      logger.error(
        `Bisection depth limit reached for account bulk upsert batch of size ${rows.length}`,
        error as Error,
      )
      return new Set()
    }

    const mid = Math.floor(rows.length / 2)
    const [left, right] = await Promise.all([
      upsertAccountsBulkWithBisection(prisma, rows.slice(0, mid), depth + 1),
      upsertAccountsBulkWithBisection(prisma, rows.slice(mid), depth + 1),
    ])
    return new Set([...left, ...right])
  }
}

/**
 * `crawler/db/label-repository.ts` の `recordAccountLabelsBulk()` と同じ `UNNEST` パターンで、
 * 複数件の Account profile を 1 ラウンドトリップで upsert する。
 * transaction client (`Prisma.TransactionClient`) を渡すと型エラーになる: bisection フォールバックは
 * 複数回に分けて実行する前提のため、単一トランザクション内で呼ぶと 1 文のエラーで
 * トランザクション全体が abort 状態になり bisection 自体が成立しないため。
 * @param prisma - Prisma クライアント (root client のみ。transaction client は型上渡せない)
 * @param inputs - upsert 対象のプロフィール一覧。同一 id が複数回出現した場合は最後の要素を採用する
 * @returns upsert に成功した author の id 集合
 */
export async function upsertAccountsBulk(
  prisma: PrismaClient,
  inputs: AccountProfileInput[],
): Promise<Set<string>> {
  if (inputs.length === 0) return new Set()

  // ON CONFLICT DO UPDATE は同一トランザクション内で同じ行を2回操作するとエラーになるため、
  // SQL を組み立てる前に id で重複排除する (後勝ち)。
  const deduped = new Map(inputs.map((input) => [input.id, input]))
  return upsertAccountsBulkWithBisection(prisma, [...deduped.values()], 0)
}
