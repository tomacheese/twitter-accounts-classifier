import { describe, expect, it } from 'vitest'
import { topicTechRule } from './topic-tech'
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

describe('topicTechRule', () => {
  it('is true for a developer/tech bio', () => {
    expect(topicTechRule.evaluate(makeBundle({ bio: 'Developer | Tech notes' })).value).toBe(true)
  })

  it('is true for a Japanese engineer bio', () => {
    expect(
      topicTechRule.evaluate(
        makeBundle({ bio: 'フリーランスエンジニアです。プログラミングが好きです' }),
      ).value,
    ).toBe(true)
  })

  it('is false for an unrelated bio', () => {
    expect(
      topicTechRule.evaluate(makeBundle({ bio: '毎日ラーメンの写真を載せています' })).value,
    ).toBe(false)
  })

  it('is false for a gaming bio mentioning the game title "Space Engineers", not tagging "engineer" as a substring', () => {
    expect(
      topicTechRule.evaluate(
        makeBundle({ bio: 'ゲーム好きです。spaceengineers をよく遊んでいます' }),
      ).value,
    ).toBe(false)
  })

  it('is true for a bio using the plural "engineers"', () => {
    expect(topicTechRule.evaluate(makeBundle({ bio: 'Backend engineers, unite!' })).value).toBe(
      true,
    )
  })

  it('is false for a bio mentioning an Amazon affiliate program, not tagging generic プログラム as tech', () => {
    expect(
      topicTechRule.evaluate(
        makeBundle({ bio: 'ライターです。Amazonアソシエイトプログラム参加者' }),
      ).value,
    ).toBe(false)
  })

  it('is true for a bio using プログラマー (programmer)', () => {
    expect(topicTechRule.evaluate(makeBundle({ bio: 'ゲームプログラマーです' })).value).toBe(true)
  })

  it('is false for a civil engineer bio', () => {
    expect(
      topicTechRule.evaluate(makeBundle({ bio: 'Civil Engineer. Bridges and roads.' })).value,
    ).toBe(false)
  })

  it('is false for a controls engineer bio', () => {
    expect(
      topicTechRule.evaluate(makeBundle({ bio: 'Controls Engineer | Factory automation' })).value,
    ).toBe(false)
  })

  it('is false for an audio engineer bio', () => {
    expect(topicTechRule.evaluate(makeBundle({ bio: 'Studio work • Audio Engineer' })).value).toBe(
      false,
    )
  })

  it('is true for a mechanical engineer who also builds software', () => {
    expect(
      topicTechRule.evaluate(makeBundle({ bio: 'Mechanical engineer turned software developer' }))
        .value,
    ).toBe(true)
  })
})
