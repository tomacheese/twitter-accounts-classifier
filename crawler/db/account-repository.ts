import type { Account, PrismaClient } from '../generated/prisma'
import type { NormalizedAccountProfile } from 'twitter-client'

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
