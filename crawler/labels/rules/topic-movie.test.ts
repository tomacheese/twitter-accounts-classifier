import { describe, expect, it } from 'vitest'
import { topicMovieRule } from './topic-movie'
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

describe('topicMovieRule', () => {
  it('is true for a bio declaring a love of movies', () => {
    expect(
      topicMovieRule.evaluate(makeBundle({ bio: '映画好きの会社員です。年間100本鑑賞します' }))
        .value,
    ).toBe(true)
  })

  it('is true for a bio mentioning drama-watching', () => {
    expect(
      topicMovieRule.evaluate(
        makeBundle({ bio: '韓国ドラマにハマっています。おすすめ教えてください' }),
      ).value,
    ).toBe(true)
  })

  it('is true for an English cinephile bio', () => {
    expect(
      topicMovieRule.evaluate(makeBundle({ bio: 'Cinephile | Reviewing one film a week' })).value,
    ).toBe(true)
  })

  it('is false for an unrelated bio', () => {
    expect(
      topicMovieRule.evaluate(makeBundle({ bio: '毎日ラーメンの写真を載せています' })).value,
    ).toBe(false)
  })

  it('is false for a bio containing "film" only as a substring of an unrelated word', () => {
    expect(
      topicMovieRule.evaluate(makeBundle({ bio: 'Currently filming a documentary project' })).value,
    ).toBe(false)
  })
})
