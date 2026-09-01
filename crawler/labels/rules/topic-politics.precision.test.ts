import { describe, expect, it } from 'vitest'
import type { AccountFeatureBundle } from '../types'
import { topicPoliticsRule } from './topic-politics'

function makeBundle(bio: string): AccountFeatureBundle {
  return {
    account: {
      id: 'fictional-politics-1',
      screenName: 'fictional_politics',
      displayName: 'Fictional Politics',
      bio,
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date(),
      isBlueVerified: false,
      verifiedType: null,
    },
    recentTweets: [],
  }
}

describe('topicPoliticsRule precision regressions', () => {
  it.each([
    '作家、政治家です、父',
    '前衆議院議員です。現在は評論家です',
    '前○○市議会議員です。今は会社員です',
    '参議院議員、衆議院議員、○○大臣など歴任。現在は評論家です',
    '国会議員、官庁、大企業向けに広報コンサルティングをしています',
  ])('does not infer a current office from non-current or contextual wording: %s', (bio) => {
    expect(topicPoliticsRule.evaluate(makeBundle(bio)).value).toBe(false)
  })

  it('keeps a later independent current affiliation after a former-office mention', () => {
    expect(
      topicPoliticsRule.evaluate(
        makeBundle('元○○市議会議員です。現在は自民党所属、参議院議員をしています'),
      ).value,
    ).toBe(true)
  })

  it('keeps a current office stated after a past-career listing', () => {
    expect(
      topicPoliticsRule.evaluate(
        makeBundle('参議院議員、衆議院議員、○○大臣など歴任。現在は市議会議員をしています'),
      ).value,
    ).toBe(true)
  })

  it.each([
    '国会議員をしています。よろしくお願いします',
    '自民党党員です。地域活動をしています',
    'U.S. Senator for Example State. Serving my constituents.',
  ])('preserves explicit current office or party declarations: %s', (bio) => {
    expect(topicPoliticsRule.evaluate(makeBundle(bio)).value).toBe(true)
  })
})
