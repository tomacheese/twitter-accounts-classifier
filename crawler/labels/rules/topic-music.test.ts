import { describe, expect, it } from 'vitest'
import { topicMusicRule } from './topic-music'
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

describe('topicMusicRule', () => {
  it('is true for a bio declaring an instrument/band role', () => {
    expect(
      topicMusicRule.evaluate(
        makeBundle({ bio: 'サンプルバンドという名前のバンドでベース弾いてます' }),
      ).value,
    ).toBe(true)
  })

  it('is true for an English musician bio', () => {
    expect(
      topicMusicRule.evaluate(makeBundle({ bio: 'Software Developer by day, Musician by night' }))
        .value,
    ).toBe(true)
  })

  it('is true for a Japanese "音楽" bio', () => {
    expect(topicMusicRule.evaluate(makeBundle({ bio: '趣味は映画と読書と音楽です' })).value).toBe(
      true,
    )
  })

  it('is false for an unrelated bio', () => {
    expect(
      topicMusicRule.evaluate(makeBundle({ bio: '毎日ラーメンの写真を載せています' })).value,
    ).toBe(false)
  })

  it('is false for a bio containing "band" only as a substring of an unrelated word', () => {
    expect(
      topicMusicRule.evaluate(makeBundle({ bio: 'Proud husband and father of two' })).value,
    ).toBe(false)
  })
})
