import type { Account, PrismaClient } from '../generated/prisma'

export interface AccountProfileInput {
  id: string
  screenName: string
  displayName: string
  bio: string | null
  profileImageUrl: string | null
  followersCount: number
  followingCount: number
  tweetCount: number
  accountCreatedAt: Date
  location: string | null
  url: string | null
  isBlueVerified: boolean
  verifiedType: string | null
  professionalType: string | null
  parodyCommentaryFanLabel: string | null
}

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
