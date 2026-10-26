import { describe, expect, it } from 'vitest'
import { hasProminentTopicMention } from './hobby-list-mention'

const PATTERN = /料理|旅行/

describe('hasProminentTopicMention', () => {
  it('is false when there is no match', () => {
    expect(hasProminentTopicMention('日常の記録', PATTERN)).toBe(false)
  })

  it('is true for a single word outside a list', () => {
    expect(hasProminentTopicMention('料理が好きです', PATTERN)).toBe(true)
  })

  it('is true for a word in a two-item list', () => {
    expect(hasProminentTopicMention('読書・料理', PATTERN)).toBe(true)
  })

  it('is false for a single word in a three-item list', () => {
    expect(hasProminentTopicMention('読書・ゲーム・料理', PATTERN)).toBe(false)
  })

  it('is true for two distinct words even in a list', () => {
    expect(hasProminentTopicMention('読書・料理・旅行', PATTERN)).toBe(true)
  })

  it('is true for a word in its own sentence next to a list sentence', () => {
    expect(hasProminentTopicMention('読書・ゲーム・散歩。料理が得意です', PATTERN)).toBe(true)
  })

  it('is false for a single word among three or more hashtags', () => {
    expect(hasProminentTopicMention('日常です #読書 #ゲーム #料理', PATTERN)).toBe(false)
  })

  it('is true for a single hashtag next to one other item', () => {
    expect(hasProminentTopicMention('料理の勉強中 #料理', PATTERN)).toBe(true)
  })

  it('is true when the topic word also appears in prose next to hashtags', () => {
    expect(hasProminentTopicMention('料理人です #読書 #ゲーム #料理', PATTERN)).toBe(true)
  })

  it('is true for a prose mention before a long hashtag list', () => {
    expect(hasProminentTopicMention('料理は大好き #読書 #ゲーム #散歩', PATTERN)).toBe(true)
  })
})
