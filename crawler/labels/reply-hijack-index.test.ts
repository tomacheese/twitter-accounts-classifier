import { describe, expect, it } from 'vitest'
import { buildReplyHijackIndex, type ReplyHijackCorpusEntry } from './reply-hijack-index'

function entry(
  accountId: string,
  fullText: string,
  inReplyToTweetId: string | null,
  hoursAgo: number,
): ReplyHijackCorpusEntry {
  return {
    accountId,
    fullText,
    inReplyToTweetId,
    createdAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
  }
}

describe('buildReplyHijackIndex', () => {
  it('reports a swarm size for a target with 5+ distinct authors posting similar text within the window', () => {
    const corpus = [
      entry('a1', 'この教材は本当に9800円の価値がありましたね😭', 'target1', 0),
      entry('a2', '9800円払う価値が十分にある教材でしたね😭', 'target1', 1),
      entry('a3', '正直9800円分の価値は十分にありました😭', 'target1', 2),
      entry('a4', 'これは9800円の価値がある教材だと思います😭', 'target1', 3),
      entry('a5', '9800円出しても惜しくない教材でしたね😭', 'target1', 4),
    ]

    const index = buildReplyHijackIndex(corpus)

    expect(index.swarmSizeFor('a1', 'target1')).toBe(5)
    expect(index.swarmSizeFor('a3', 'target1')).toBe(5)
  })

  it('is 0 for a target with fewer than 5 distinct authors', () => {
    const corpus = [
      entry('a1', '同じような内容の返信です同じような内容の返信です', 'target1', 0),
      entry('a2', '同じような内容の返信です同じような内容の返信です', 'target1', 1),
    ]

    const index = buildReplyHijackIndex(corpus)

    expect(index.swarmSizeFor('a1', 'target1')).toBe(0)
  })

  it('is 0 when 5+ distinct authors reply to the same target but with dissimilar text', () => {
    const corpus = [
      entry('a1', '今日はとても良い天気で気持ちがいいですね', 'target1', 0),
      entry('a2', '先週から猫を飼い始めてとても癒されています', 'target1', 1),
      entry('a3', '新しいゲームを買ったので週末に遊ぶ予定です', 'target1', 2),
      entry('a4', '最近は仕事がとても忙しくて疲れがたまります', 'target1', 3),
      entry('a5', '来週の週末は家族と旅行に行く予定でいます', 'target1', 4),
    ]

    const index = buildReplyHijackIndex(corpus)

    expect(index.swarmSizeFor('a1', 'target1')).toBe(0)
  })

  it('is 0 when the 5+ distinct-author replies span more than the 24-hour window', () => {
    const corpus = [
      entry('a1', 'この教材は本当に9800円の価値がありましたね😭', 'target1', 0),
      entry('a2', '9800円払う価値が十分にある教材でしたね😭', 'target1', 10),
      entry('a3', '正直9800円分の価値は十分にありました😭', 'target1', 20),
      entry('a4', 'これは9800円の価値がある教材だと思います😭', 'target1', 30),
      entry('a5', '9800円出しても惜しくない教材でしたね😭', 'target1', 40),
    ]

    const index = buildReplyHijackIndex(corpus)

    expect(index.swarmSizeFor('a1', 'target1')).toBe(0)
  })

  it("dedupes to one entry per author per target, using each author's first reply", () => {
    const corpus = [
      entry('a1', 'この教材は本当に9800円の価値がありましたね😭', 'target1', 0),
      entry('a1', '全然関係ない内容の2回目のリプライを書いています', 'target1', 1),
      entry('a2', '9800円払う価値が十分にある教材でしたね😭', 'target1', 2),
      entry('a3', '正直9800円分の価値は十分にありました😭', 'target1', 3),
      entry('a4', 'これは9800円の価値がある教材だと思います😭', 'target1', 4),
      entry('a5', '9800円出しても惜しくない教材でしたね😭', 'target1', 5),
    ]

    const index = buildReplyHijackIndex(corpus)

    expect(index.swarmSizeFor('a1', 'target1')).toBe(5)
  })

  it('ignores entries with no target tweet id', () => {
    const corpus = [
      entry('a1', 'この教材は本当に9800円の価値がありましたね😭', null, 0),
      entry('a2', '9800円払う価値が十分にある教材でしたね😭', null, 1),
    ]

    const index = buildReplyHijackIndex(corpus)

    expect(index.swarmSizeFor('a1', 'target1')).toBe(0)
  })

  it('is 0 for a crowd of short greetings under one tweet, which are near-identical only because they are too short to differ', () => {
    const corpus = [
      entry('a1', '@morningperson おはようございます', 'target1', 0),
      entry('a2', '@morningperson おはよ〜！', 'target1', 0.1),
      entry('a3', '@morningperson おはようさん✨', 'target1', 0.2),
      entry('a4', '@morningperson おはよー', 'target1', 0.3),
      entry('a5', '@morningperson おはよう☀', 'target1', 0.4),
      entry('a6', '@morningperson おはようございます！', 'target1', 0.5),
    ]

    const index = buildReplyHijackIndex(corpus)

    expect(index.swarmSizeFor('a1', 'target1')).toBe(0)
  })

  it('returns 0 for an account/target pair not present in any qualifying swarm', () => {
    const index = buildReplyHijackIndex([])

    expect(index.swarmSizeFor('unknown', 'target1')).toBe(0)
  })
})
