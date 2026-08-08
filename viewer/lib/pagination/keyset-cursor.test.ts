import { describe, it, expect } from 'vitest'
import { encodeCursor, decodeCursor } from './keyset-cursor'

describe('keyset cursor', () => {
  it('encode したものを decode すると同じ値が戻る', () => {
    const cursor = encodeCursor({
      sortValues: ['2026-08-07T00:00:00.000Z', 'account-1'],
      filterHash: 'f1',
    })
    const decoded = decodeCursor(cursor, 'f1')
    expect(decoded).toEqual(['2026-08-07T00:00:00.000Z', 'account-1'])
  })

  it('filter が変わっていたら不一致として null を返す', () => {
    const cursor = encodeCursor({ sortValues: ['x'], filterHash: 'f1' })
    expect(decodeCursor(cursor, 'f2')).toBeNull()
  })

  it('壊れた cursor 文字列は null を返す (無効値を黙って無視しない呼び出し側が判定できるようにする)', () => {
    expect(decodeCursor('not-base64!!', 'f1')).toBeNull()
  })

  it('sortValues を含まない JSON は null を返す', () => {
    const cursor = Buffer.from(JSON.stringify({ filterHash: 'f1' })).toString('base64url')
    expect(decodeCursor(cursor, 'f1')).toBeNull()
  })

  it('sortValues が配列でなければ null を返す', () => {
    const cursor = Buffer.from(JSON.stringify({ sortValues: 'x', filterHash: 'f1' })).toString(
      'base64url',
    )
    expect(decodeCursor(cursor, 'f1')).toBeNull()
  })

  it('sortValues に文字列以外の要素が混ざっていたら null を返す', () => {
    for (const sortValues of [[1, 'account-1'], ['2026-08-07T00:00:00.000Z', null], [{}], [[]]]) {
      const cursor = Buffer.from(JSON.stringify({ sortValues, filterHash: 'f1' })).toString(
        'base64url',
      )
      expect(decodeCursor(cursor, 'f1')).toBeNull()
    }
  })

  it('空の sortValues は有効な cursor として扱う', () => {
    const cursor = encodeCursor({ sortValues: [], filterHash: 'f1' })
    expect(decodeCursor(cursor, 'f1')).toEqual([])
  })
})
