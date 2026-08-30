import { expect, it, vi } from 'vitest'
import type { PrismaClient, Tweet } from './generated/prisma'
import * as labelRepository from './db/label-repository'
import * as tweetRepository from './db/tweet-repository'
import * as workItemRepository from './db/analysis-work-item-repository'
import { LabelRuleRegistry } from './labels/registry'
import type { AccountFeatureBundle, LabelRule } from './labels/types'
import { evaluateAccountRelabelItems } from './relabel-worker'

it('relabel evaluation receives the resolved parent author id', async () => {
  let observedParentAuthorId: string | null | undefined
  const probeRule: LabelRule = {
    key: 'parent_author_probe',
    version: '1.0.0',
    description: 'test probe',
    evaluate(bundle: AccountFeatureBundle) {
      observedParentAuthorId = bundle.recentTweets[0]?.parentTweetAuthorId
      return { value: false, confidence: 1, reason: 'probe' }
    },
  }
  const registry = new LabelRuleRegistry()
  registry.register(probeRule)
  const prisma = {
    account: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'account-1',
          screenName: 'a',
          displayName: 'A',
          bio: null,
          followersCount: 0,
          followingCount: 0,
          tweetCount: 1,
          accountCreatedAt: new Date('2026-01-01T00:00:00Z'),
          isBlueVerified: false,
          verifiedType: null,
          recentTweetsFetchStatus: 'success',
        },
      ]),
    },
    $transaction: vi.fn((fn: (tx: PrismaClient) => Promise<unknown>) => fn(prisma as never)),
  } as unknown as PrismaClient
  vi.spyOn(tweetRepository, 'loadRecentTweetsForAccounts').mockResolvedValue(
    new Map([
      [
        'account-1',
        [
          {
            id: 'reply-1',
            accountId: 'account-1',
            fullText: 'reply',
            createdAt: new Date('2026-08-29T00:00:00Z'),
            isReply: true,
            inReplyToTweetId: 'parent-1',
            isRetweet: false,
          },
        ] as Tweet[],
      ],
    ]),
  )
  vi.spyOn(tweetRepository, 'findTweetTextsByIds').mockResolvedValue(
    new Map([['parent-1', 'parent text']]),
  )
  const contextSpy = vi
    .spyOn(tweetRepository, 'findTweetContextsByIds')
    .mockResolvedValue(
      new Map([['parent-1', { fullText: 'parent text', accountId: 'parent-author' }]]),
    )
  vi.spyOn(labelRepository, 'recordAccountLabelsBulkForAccounts').mockResolvedValue([])
  vi.spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk').mockResolvedValue([
    { id: 'wi-1', status: 'succeeded' },
  ])
  vi.spyOn(workItemRepository, 'claimStillLeasedWorkItemIdsForUpdate').mockResolvedValue(['wi-1'])

  await evaluateAccountRelabelItems(prisma, [{ id: 'wi-1', triggerId: 'account-1' } as never], {
    registry,
    labelDefinitionIds: new Map([[probeRule.key, 'def-1']]),
    duplicateReplyIndex: { countOtherAccounts: () => 0 },
    bioDuplicateIndex: { countOtherAccounts: () => 0 },
    replyHijackIndex: {
      swarmSizeFor: () => 0,
      isEligibleForScreening: () => false,
      evidenceFor: () => undefined,
    },
    followGraphLabelIndex: { signalsFor: () => ({}) },
    selfReplyPromoIndex: { evidenceFor: () => undefined },
    concurrency: 1,
    leaseOwner: 'test-worker',
  })

  expect(contextSpy).toHaveBeenCalledWith(prisma, ['parent-1'])
  expect(observedParentAuthorId).toBe('parent-author')
})
