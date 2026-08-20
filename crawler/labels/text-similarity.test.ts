import { describe, expect, it } from 'vitest'
import {
  normalizeForSimilarity,
  bigramSet,
  jaccardSimilarity,
  averagePairwiseSimilarity,
} from './text-similarity'

describe('normalizeForSimilarity', () => {
  it('strips urls, mentions, and collapses whitespace', () => {
    expect(normalizeForSimilarity('@foo  https://example.com/x  Hello   World')).toBe('hello world')
  })

  it('keeps hashtags by default for existing callers', () => {
    expect(normalizeForSimilarity('本文 #共通タグ')).toContain('#共通タグ')
  })

  it('removes hashtag tokens when requested', () => {
    expect(normalizeForSimilarity('本文 #共通タグ', { removeHashtags: true })).toBe('本文')
  })
})

describe('bigramSet', () => {
  it('builds character bigrams', () => {
    expect(bigramSet('abc')).toEqual(new Set(['ab', 'bc']))
  })

  it('returns a single-character set for length-1 input', () => {
    expect(bigramSet('a')).toEqual(new Set(['a']))
  })

  it('returns an empty set for empty input', () => {
    expect(bigramSet('')).toEqual(new Set())
  })
})

describe('jaccardSimilarity', () => {
  it('is 1 for identical sets', () => {
    expect(jaccardSimilarity(new Set(['ab', 'bc']), new Set(['ab', 'bc']))).toBe(1)
  })

  it('is 0 when either set is empty', () => {
    expect(jaccardSimilarity(new Set(), new Set(['ab']))).toBe(0)
  })
})

describe('averagePairwiseSimilarity', () => {
  it('averages similarity across every pair', () => {
    const result = averagePairwiseSimilarity(['abc', 'abc', 'xyz'])
    // ペアは (abc,abc)=1、(abc,xyz)=0、(abc,xyz)=0 の3組で、平均は1/3になる
    expect(result).toBeCloseTo(1 / 3, 5)
  })

  it('is 0 for a single text (no pairs)', () => {
    expect(averagePairwiseSimilarity(['abc'])).toBe(0)
  })
})

describe('averagePairwiseSimilarity with removeCommonPhrases', () => {
  it('ignores a shared running-gag phrase that appears in most texts of the group', () => {
    const texts = [
      '実況実況 このシーンで泣いた',
      '実況実況 まさかの展開すぎる',
      '実況実況 ここで笑うとは思わなかった',
      '実況実況 次の場面が気になる',
      '実況実況 このセリフ好き',
    ]
    const withoutRemoval = averagePairwiseSimilarity(texts)
    const withRemoval = averagePairwiseSimilarity(texts, { removeCommonPhrases: true })
    expect(withRemoval).toBeLessThan(withoutRemoval)
  })

  it('still detects paraphrased duplicates that do not share a fixed common phrase', () => {
    const texts = [
      'この動画おもしろすぎて何回も見ちゃった',
      '何回見てもこの動画おもしろすぎる',
      'この動画ほんとにおもしろい、笑いが止まらない',
    ]
    const similarity = averagePairwiseSimilarity(texts, { removeCommonPhrases: true })
    expect(similarity).toBeGreaterThan(0.03)
  })

  it('does not collapse to 0 for a group of texts that are literally identical', () => {
    const texts = Array.from({ length: 10 }, () => 'これはひどい')
    const similarity = averagePairwiseSimilarity(texts, { removeCommonPhrases: true })
    expect(similarity).toBe(1)
  })
})
