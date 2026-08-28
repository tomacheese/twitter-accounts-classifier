import { describe, expect, it } from 'vitest'
import { buildBioDuplicateIndex, normalizeBioText } from './bio-duplicate-index'

describe('normalizeBioText', () => {
  it('strips URLs and mentions, collapses whitespace, and lowercases', () => {
    expect(
      normalizeBioText(
        '@example_user 毎日投稿しています。仲良くしてください！ https://t.co/exampleXXXX',
      ),
    ).toBe('毎日投稿しています。仲良くしてください！')
  })

  it('returns an empty string for text shorter than the minimum meaningful length', () => {
    expect(normalizeBioText('よろしく')).toBe('')
  })

  it('returns an empty string when normalized length is exactly one below the minimum', () => {
    expect(normalizeBioText('あ'.repeat(19))).toBe('')
  })

  it('returns the normalized text when length is exactly at the minimum', () => {
    const text = 'あ'.repeat(20)
    expect(normalizeBioText(text)).toBe(text)
  })
})

describe('buildBioDuplicateIndex', () => {
  it('counts distinct other accounts sharing an identical normalized bio', () => {
    const index = buildBioDuplicateIndex([
      { accountId: 'a1', bio: '毎日投稿しています。仲良くしてください、DMは受け付けていません' },
      { accountId: 'a2', bio: '毎日投稿しています。仲良くしてください、DMは受け付けていません' },
      { accountId: 'a3', bio: '毎日投稿しています。仲良くしてください、DMは受け付けていません' },
    ])

    expect(
      index.countOtherAccounts(
        '毎日投稿しています。仲良くしてください、DMは受け付けていません',
        'a1',
      ),
    ).toBe(2)
  })

  it('is case-insensitive and ignores URL/mention differences between accounts', () => {
    const bio = 'アニメと漫画とゲームが大好きな平凡な会社員です、よろしくお願いします'
    const index = buildBioDuplicateIndex([
      { accountId: 'a1', bio: `@foo ${bio} https://t.co/exampleAAAA` },
      { accountId: 'a2', bio: `@bar ${bio} https://t.co/exampleBBBB` },
    ])

    expect(index.countOtherAccounts(bio, 'a1')).toBe(1)
  })

  it('returns 0 when no other account shares the normalized bio', () => {
    const index = buildBioDuplicateIndex([
      { accountId: 'a1', bio: '毎日投稿しています。仲良くしてください、DMは受け付けていません' },
    ])

    expect(
      index.countOtherAccounts(
        '毎日投稿しています。仲良くしてください、DMは受け付けていません',
        'a1',
      ),
    ).toBe(0)
  })

  it('returns 0 for bio text shorter than the minimum meaningful length', () => {
    const index = buildBioDuplicateIndex([
      { accountId: 'a1', bio: 'よろしく' },
      { accountId: 'a2', bio: 'よろしく' },
    ])

    expect(index.countOtherAccounts('よろしく', 'a1')).toBe(0)
  })

  it('counts a match when bio length is exactly at the minimum meaningful length', () => {
    const bio = 'あ'.repeat(20)
    const index = buildBioDuplicateIndex([
      { accountId: 'a1', bio },
      { accountId: 'a2', bio },
    ])

    expect(index.countOtherAccounts(bio, 'a1')).toBe(1)
  })
})
