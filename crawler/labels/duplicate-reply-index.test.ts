import { describe, expect, it } from 'vitest'
import { buildDuplicateReplyIndex, normalizeReplyText } from './duplicate-reply-index'

describe('normalizeReplyText', () => {
  it('strips URLs and mentions and lowercases the remaining text', () => {
    expect(
      normalizeReplyText(
        '@user これはとても素晴らしい情報ですね！ぜひ拡散をお願いします https://t.co/exampleXXXX',
      ),
    ).toBe('これはとても素晴らしい情報ですね！ぜひ拡散をお願いします')
  })

  it('returns an empty string for text shorter than the minimum meaningful length', () => {
    expect(normalizeReplyText('@user ありがとう')).toBe('')
  })
})

describe('buildDuplicateReplyIndex', () => {
  it('counts distinct other accounts sharing identical normalized reply text across different targets', () => {
    const index = buildDuplicateReplyIndex([
      {
        accountId: 'a1',
        fullText: '@target 今だけ無料でエアドロップ配布中！詳細はDMで確認してね',
        inReplyToTweetId: 'victim-tweet-1',
      },
      {
        accountId: 'a2',
        fullText: '@other 今だけ無料でエアドロップ配布中！詳細はDMで確認してね',
        inReplyToTweetId: 'victim-tweet-2',
      },
      {
        accountId: 'a3',
        fullText: '@third 今だけ無料でエアドロップ配布中！詳細はDMで確認してね',
        inReplyToTweetId: 'victim-tweet-3',
      },
    ])

    expect(
      index.countOtherAccounts(
        '@someone 今だけ無料でエアドロップ配布中！詳細はDMで確認してね',
        'a1',
      ),
    ).toBe(2)
  })

  it('returns 0 when the matching text was only ever seen replying to a single shared target (brand hashtag campaigns)', () => {
    const index = buildDuplicateReplyIndex([
      {
        accountId: 'a1',
        fullText: '@example_brand 冷やし麺セットが気になります #架空カフェのひんやり麺フェア',
        inReplyToTweetId: 'campaign-tweet-1',
      },
      {
        accountId: 'a2',
        fullText: '@example_brand 冷やし麺セットが気になります #架空カフェのひんやり麺フェア',
        inReplyToTweetId: 'campaign-tweet-1',
      },
      {
        accountId: 'a3',
        fullText: '@example_brand 冷やし麺セットが気になります #架空カフェのひんやり麺フェア',
        inReplyToTweetId: 'campaign-tweet-1',
      },
    ])

    expect(
      index.countOtherAccounts(
        '@example_brand 冷やし麺セットが気になります #架空カフェのひんやり麺フェア',
        'a1',
      ),
    ).toBe(0)
  })

  it('returns 0 for text with no match in the corpus', () => {
    const index = buildDuplicateReplyIndex([
      {
        accountId: 'a1',
        fullText: '今日はいい天気ですね、散歩に行きたい気分です',
        inReplyToTweetId: null,
      },
    ])

    expect(index.countOtherAccounts('全然違う内容の返信文です、マッチしません', 'a2')).toBe(0)
  })

  it('returns 0 for text below the minimum meaningful length even if it recurs', () => {
    const index = buildDuplicateReplyIndex([
      { accountId: 'a1', fullText: 'いいね！', inReplyToTweetId: null },
      { accountId: 'a2', fullText: 'いいね！', inReplyToTweetId: null },
    ])

    expect(index.countOtherAccounts('いいね！', 'a3')).toBe(0)
  })

  it('still counts duplicates when no entry in the matching group has a known target', () => {
    const index = buildDuplicateReplyIndex([
      {
        accountId: 'a1',
        fullText: '@target 今だけ無料でエアドロップ配布中！詳細はDMで確認してね',
        inReplyToTweetId: null,
      },
      {
        accountId: 'a2',
        fullText: '@other 今だけ無料でエアドロップ配布中！詳細はDMで確認してね',
        inReplyToTweetId: null,
      },
    ])

    expect(
      index.countOtherAccounts(
        '@someone 今だけ無料でエアドロップ配布中！詳細はDMで確認してね',
        'a1',
      ),
    ).toBe(1)
  })

  it('still counts duplicates when known and unknown targets are mixed', () => {
    const index = buildDuplicateReplyIndex([
      {
        accountId: 'a1',
        fullText: '@target 今だけ無料でエアドロップ配布中！詳細はDMで確認してね',
        inReplyToTweetId: 'victim-tweet-1',
      },
      {
        accountId: 'a2',
        fullText: '@other 今だけ無料でエアドロップ配布中！詳細はDMで確認してね',
        inReplyToTweetId: null,
      },
    ])

    expect(
      index.countOtherAccounts(
        '@someone 今だけ無料でエアドロップ配布中！詳細はDMで確認してね',
        'a1',
      ),
    ).toBe(1)
  })

  it('does not count the excluded account itself', () => {
    const index = buildDuplicateReplyIndex([
      {
        accountId: 'a1',
        fullText: '@target 今だけ無料でエアドロップ配布中！詳細はDMで確認してね',
        inReplyToTweetId: 'victim-tweet-1',
      },
      {
        accountId: 'a2',
        fullText: '@other 今だけ無料でエアドロップ配布中！詳細はDMで確認してね',
        inReplyToTweetId: 'victim-tweet-2',
      },
    ])

    expect(
      index.countOtherAccounts(
        '@someone 今だけ無料でエアドロップ配布中！詳細はDMで確認してね',
        'a1',
      ),
    ).toBe(1)
  })
})
