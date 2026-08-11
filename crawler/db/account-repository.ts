import type { Account, PrismaClient } from '../generated/prisma'
import type { NormalizedAccountProfile } from 'twitter-client'

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
