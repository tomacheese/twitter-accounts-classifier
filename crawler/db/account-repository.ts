import type { Account, PrismaClient } from '../generated/prisma'
import type { NormalizedAccountProfile } from 'twitter-client'

export type AccountProfileInput = NormalizedAccountProfile

export interface UpsertAccountResult {
  account: Account
  /** `AccountFeatureBundle.account` が参照するフィールドのいずれかが更新前後で変化したか。 */
  changed: boolean
}

// AccountFeatureBundle.account が参照するフィールドの集合。ラベル評価に影響しうる
// フィールドだけを変化検知の対象にすることで、無関係なフィールド更新まで
// account_relabel を要求してしまうのを避ける。
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

/**
 * Account を upsert し、ラベル評価に影響しうるフィールドが変化したかどうかも返す。
 * @param prisma - Prisma クライアント
 * @param input - 正規化済みのアカウントプロフィール
 * @returns upsert 後の Account と変化検知の結果
 */
export async function upsertAccount(
  prisma: PrismaClient,
  input: AccountProfileInput,
): Promise<UpsertAccountResult> {
  const existing = await prisma.account.findUnique({
    where: { id: input.id },
    select: Object.fromEntries(BUNDLE_RELEVANT_FIELDS.map((field) => [field, true])) as Record<
      (typeof BUNDLE_RELEVANT_FIELDS)[number],
      true
    >,
  })
  const changed = hasBundleRelevantChange(existing, input)

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
