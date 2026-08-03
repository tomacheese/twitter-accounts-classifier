import { describe, expect, it } from 'vitest'
import { topicAnimeRule } from './topic-anime'
import type { AccountFeatureBundle } from '../types'

function makeBundle(
  accountOverrides: Partial<AccountFeatureBundle['account']>,
): AccountFeatureBundle {
  return {
    account: {
      id: '1',
      screenName: 'x',
      displayName: 'X',
      bio: null,
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date(),
      isBlueVerified: false,
      verifiedType: null,
      ...accountOverrides,
    },
    recentTweets: [],
  }
}

describe('topicAnimeRule', () => {
  it('is true for an anime/manga bio', () => {
    expect(
      topicAnimeRule.evaluate(makeBundle({ bio: 'アニメと漫画が好きな社会人です' })).value,
    ).toBe(true)
  })

  it('is true for an English anime bio', () => {
    expect(topicAnimeRule.evaluate(makeBundle({ bio: 'Anime and manga fan account' })).value).toBe(
      true,
    )
  })

  it('is false for an unrelated bio', () => {
    expect(
      topicAnimeRule.evaluate(makeBundle({ bio: '毎日ラーメンの写真を載せています' })).value,
    ).toBe(false)
  })
})
