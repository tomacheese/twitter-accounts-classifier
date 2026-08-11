import { Logger } from '@book000/node-utils'
import { Prisma, type Account, type PrismaClient } from '../generated/prisma'
import type { NormalizedAccountProfile } from 'twitter-client'

const logger = Logger.configure('account-repository')

export type AccountProfileInput = NormalizedAccountProfile

export interface UpsertAccountResult {
  account: Account
  /** `AccountFeatureBundle.account` が参照するフィールドのいずれかが更新前後で変化したか。 */
  changed: boolean
}

// AccountFeatureBundle.account が参照するフィールドの集合。
// ラベル評価に影響しうるフィールドだけを変化検知の対象にし、
// 無関係なフィールド更新まで account_relabel を要求するのを避ける。
const BUNDLE_RELEVANT_FIELDS = [
  'screenName',
  'displayName',
  'bio',
  'followersCount',
  'followingCount',
  'tweetCount',
  'isBlueVerified',
  'verifiedType',
  'professionalType',
  'parodyCommentaryFanLabel',
] as const

type BundleRelevantAccountFields = Pick<Account, (typeof BUNDLE_RELEVANT_FIELDS)[number]>

/**
 * ラベル評価に影響しうるフィールドが更新前後で変化したかを判定する。
 * @param existing - 更新前の対象フィールドの値。行が存在しない場合は null
 * @param input - 今回の入力値
 * @returns 変化があれば true
 */
function hasBundleRelevantChange(
  existing: BundleRelevantAccountFields | null,
  input: AccountProfileInput,
): boolean {
  if (existing === null) return true
  return BUNDLE_RELEVANT_FIELDS.some((field) => existing[field] !== input[field])
}

export interface UpsertAccountOptions {
  /**
   * true の場合のみ upsert 前に既存値を取得して変化検知を行う。
   * 呼び出し元の大半は `changed` を読まず、
   * 全 upsert に検知用の追加 SELECT を課すと高頻度な follow/block 同期経路の
   * ラウンドトリップ数が倍になるため、必要な呼び出し元だけが明示的に opt-in する。
   */
  detectChange?: boolean
}

/**
 * Account を upsert し、`detectChange` が指定されたときのみラベル評価に
 * 影響しうるフィールドが変化したかどうかも返す。
 * @param prisma - Prisma クライアント
 * @param input - 正規化済みのアカウントプロフィール
 * @param options - 変化検知の要否
 * @returns upsert 後の Account と変化検知の結果 (`detectChange` 未指定時は常に false)
 */
export async function upsertAccount(
  prisma: PrismaClient,
  input: AccountProfileInput,
  options?: UpsertAccountOptions,
): Promise<UpsertAccountResult> {
  const changed = options?.detectChange
    ? hasBundleRelevantChange(
        await prisma.account.findUnique({
          where: { id: input.id },
          select: Object.fromEntries(
            BUNDLE_RELEVANT_FIELDS.map((field) => [field, true]),
          ) as Record<(typeof BUNDLE_RELEVANT_FIELDS)[number], true>,
        }),
        input,
      )
    : false

  const now = new Date()
  const account = await prisma.account.upsert({
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

  return { account, changed }
}

interface UpsertAccountsBulkRow {
  id: string
}

// row-local (行内容に起因する決定的なエラー): NOT NULL 制約違反・チェック制約違反・型不一致等。
// このホワイトリストに載らない SQLSTATE は systemic 側として扱う (安全側に倒す)。
const ROW_LOCAL_SQLSTATE_PREFIXES = ['22', '23502', '23514']

/**
 * Prisma の raw query エラーから実際の Postgres SQLSTATE を抽出する。
 * raw query 失敗時の top-level `error.code` は Prisma 独自のラッパーコード
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

/**
 * 分割の再帰段数に上限を設け、想定外の無限再帰を防ぐ。
 * 再帰中に縮小していく現在のスライス長ではなく、最初のバッチサイズから 1 件に到達するまでに
 * 必要な段数を基準にする。縮小後のスライス長を基準にすると上限が段数の増加より速く縮み、
 * 1 件まで分割し切る前にガードが働いて正常な行まで巻き込んで捨ててしまうため。
 * @param initialBatchSize - bisection を開始した時点のバッチサイズ
 */
function maxBisectionDepth(initialBatchSize: number): number {
  return Math.ceil(Math.log2(Math.max(initialBatchSize, 1))) * 4
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
  maxDepth: number,
): Promise<Set<string>> {
  if (rows.length === 0) return new Set()

  try {
    const result = await upsertAccountsBulkQuery(prisma, rows)
    return new Set(result.map((r) => r.id))
  } catch (error) {
    const sqlState = extractPostgresSqlState(error)
    const isRowLocal = sqlState !== null && isRowLocalSqlState(sqlState)
    const isSystemic = sqlState === null || !isRowLocal
    if (isSystemic) throw error

    if (rows.length === 1) {
      logger.error(`Skipping row-invalid account ${rows[0].id} in bulk upsert`, error as Error)
      return new Set()
    }
    if (depth >= maxDepth) {
      logger.error(
        `Bisection depth limit reached for account bulk upsert batch of size ${rows.length}`,
        error as Error,
      )
      return new Set()
    }

    // 複数の row-local error を含むバッチでの並列 fan-out が接続プールを食い尽くさないよう、
    // 両半分は直列に処理する。
    const mid = Math.floor(rows.length / 2)
    const left = await upsertAccountsBulkWithBisection(
      prisma,
      rows.slice(0, mid),
      depth + 1,
      maxDepth,
    )
    const right = await upsertAccountsBulkWithBisection(
      prisma,
      rows.slice(mid),
      depth + 1,
      maxDepth,
    )
    return new Set([...left, ...right])
  }
}

/**
 * `crawler/db/label-repository.ts` の `recordAccountLabelsBulk()` と同じ `UNNEST` パターンで、
 * 複数件の Account profile を 1 ラウンドトリップで upsert する。
 * bisection フォールバックは複数回に分けて実行する前提のため、
 * transaction client 内で呼ぶと 1 件のエラーでトランザクション全体が abort し、
 * bisection 自体が成立しなくなる。そのため引数の型で root client のみに制限している。
 * @param prisma - Prisma クライアント (root client のみ。transaction client は型上渡せない)
 * @param inputs - upsert 対象のプロフィール一覧。同一 id が複数回出現した場合は最後の要素を採用する
 * @returns upsert に成功した author の id 集合
 */
export async function upsertAccountsBulk(
  prisma: PrismaClient,
  inputs: AccountProfileInput[],
): Promise<Set<string>> {
  if (inputs.length === 0) return new Set()

  // ON CONFLICT DO UPDATE は同一トランザクション内で同じ行を 2 回操作するとエラーになるため、
  // SQL を組み立てる前に id で重複排除する (後勝ち)。
  const deduped = new Map(inputs.map((input) => [input.id, input]))
  const rows = [...deduped.values()]
  return upsertAccountsBulkWithBisection(prisma, rows, 0, maxBisectionDepth(rows.length))
}
