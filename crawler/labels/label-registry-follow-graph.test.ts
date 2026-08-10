import { describe, expect, it } from 'vitest'
import { ALL_LABEL_RULES } from './all-rules'

const EXPECTED_FOLLOW_GRAPH_RULE_KEYS = new Set([
  'topic_anime',
  'topic_beauty',
  'topic_crypto',
  'topic_finance',
  'topic_fitness',
  'topic_food',
  'topic_gaming',
  'topic_idol',
  'topic_illustration',
  'topic_movie',
  'topic_music',
  'topic_parenting',
  'topic_pets',
  'topic_sports',
  'topic_tech',
  'topic_travel',
  'topic_vrchat',
  'topic_vtuber',
])

describe('LabelRule.usesFollowGraphSignal registry consistency', () => {
  it('marks exactly the 18 topic rules that call hasFollowGraphTopicSignal', () => {
    const actual = new Set(
      ALL_LABEL_RULES.filter((rule) => rule.usesFollowGraphSignal).map((rule) => rule.key),
    )
    expect(actual).toEqual(EXPECTED_FOLLOW_GRAPH_RULE_KEYS)
  })
})
