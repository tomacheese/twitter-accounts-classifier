import { describe, expect, it } from 'vitest'
import {
  countLowEffortSignals,
  isDefaultAvatar,
  isEmptyBio,
  isMechanicalUsername,
  lowEffortSignatureScore,
} from './low-effort-signup-signal'

describe('isDefaultAvatar', () => {
  it('is true for a URL containing the default avatar marker', () => {
    expect(
      isDefaultAvatar(
        'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png',
      ),
    ).toBe(true)
  })

  it('is false for a custom avatar URL', () => {
    expect(isDefaultAvatar('https://pbs.twimg.com/profile_images/example/avatar.jpg')).toBe(false)
  })

  it('is false for null', () => {
    expect(isDefaultAvatar(null)).toBe(false)
  })
})

describe('isMechanicalUsername', () => {
  it('is true for a screen name ending in 4 or more digits', () => {
    expect(isMechanicalUsername('example_user1234')).toBe(true)
  })

  it('is false for a screen name ending in fewer than 4 digits', () => {
    expect(isMechanicalUsername('example_user123')).toBe(false)
  })

  it('is false for a screen name with no trailing digits', () => {
    expect(isMechanicalUsername('example_user')).toBe(false)
  })
})

describe('isEmptyBio', () => {
  it('is true for null', () => {
    expect(isEmptyBio(null)).toBe(true)
  })

  it('is true for a whitespace-only bio', () => {
    expect(isEmptyBio('   ')).toBe(true)
  })

  it('is false for a non-empty bio', () => {
    expect(isEmptyBio('毎日投稿しています')).toBe(false)
  })
})

describe('countLowEffortSignals', () => {
  it('counts all three signals when all match', () => {
    expect(
      countLowEffortSignals({
        screenName: 'example_user1234',
        bio: null,
        profileImageUrl:
          'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png',
      }),
    ).toBe(3)
  })

  it('counts zero signals for a normal account', () => {
    expect(
      countLowEffortSignals({
        screenName: 'example_user',
        bio: '毎日投稿しています',
        profileImageUrl: 'https://pbs.twimg.com/profile_images/example/avatar.jpg',
      }),
    ).toBe(0)
  })

  it('counts exactly one signal when only the username is mechanical', () => {
    expect(
      countLowEffortSignals({
        screenName: 'example_user1234',
        bio: '毎日投稿しています',
        profileImageUrl: 'https://pbs.twimg.com/profile_images/example/avatar.jpg',
      }),
    ).toBe(1)
  })
})

describe('lowEffortSignatureScore', () => {
  it('is at least 0.5 once 2 or more signals match', () => {
    expect(lowEffortSignatureScore(2)).toBeGreaterThanOrEqual(0.5)
  })

  it('is 0 when no signal matches', () => {
    expect(lowEffortSignatureScore(0)).toBe(0)
  })

  it('is 0 for exactly one matching signal, so it alone must not move confidence', () => {
    expect(lowEffortSignatureScore(1)).toBe(0)
  })
})
