import { describe, expect, it } from 'vitest'
import {
  InvalidIdError,
  MAX_BIGINT_ID,
  compareIds,
  createSyntheticId,
  createSyntheticSerialId,
  fromBigIntId,
  fromBigIntIdOrNull,
  fromBigIntIds,
  toBigIntId,
  toBigIntIdOrNull,
  toBigIntIds,
} from './id-codec'

describe('toBigIntId / fromBigIntId', () => {
  it.each(['0', '1', '1234567890123456789', '9223372036854775807', '9007199254740993'])(
    '%s を桁落ちなく往復する',
    (id) => {
      expect(fromBigIntId(toBigIntId(id))).toBe(id)
    },
  )

  it('Number.MAX_SAFE_INTEGER を超える 19 桁の ID を bigint で正確に保持する', () => {
    expect(toBigIntId('9007199254740993')).toBe(9_007_199_254_740_993n)
  })

  it('bigint と安全な整数の number はそのまま受け付ける', () => {
    expect(toBigIntId(42n)).toBe(42n)
    expect(toBigIntId(42)).toBe(42n)
  })

  it.each([
    ['', 'must be a decimal integer without leading zeros'],
    ['abc', 'must be a decimal integer without leading zeros'],
    ['12a', 'must be a decimal integer without leading zeros'],
    ['-1', 'must be a decimal integer without leading zeros'],
    ['1.5', 'must be a decimal integer without leading zeros'],
    [' 1', 'must be a decimal integer without leading zeros'],
    ['007', 'must be a decimal integer without leading zeros'],
    ['12345678901234567890', 'must be a decimal integer without leading zeros'],
    ['9223372036854775808', 'out of the bigint id range'],
  ])('文字列 "%s" を拒否する', (value, reason) => {
    expect(() => toBigIntId(value)).toThrow(new InvalidIdError(value, reason))
  })

  it('エラーメッセージに型と値を含める', () => {
    expect(() => toBigIntId('abc')).toThrow(
      'Invalid id string "abc": must be a decimal integer without leading zeros',
    )
  })

  it('長すぎる値はエラーメッセージで切り詰める', () => {
    expect(() => toBigIntId('x'.repeat(100))).toThrow(`string "${'x'.repeat(40)}..."`)
  })

  it.each([1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, -1])('number %s を拒否する', (value) => {
    expect(() => toBigIntId(value)).toThrow(InvalidIdError)
  })

  it('範囲外の bigint を拒否する', () => {
    expect(() => toBigIntId(-1n)).toThrow(InvalidIdError)
    expect(() => toBigIntId(MAX_BIGINT_ID + 1n)).toThrow(InvalidIdError)
  })

  it('文字列・数値・bigint 以外を拒否する', () => {
    expect(() => toBigIntId(true as unknown as string)).toThrow(
      'Invalid id boolean "true": must be a string, number or bigint',
    )
  })
})

describe('null の扱い', () => {
  it('null と undefined はそのまま返す', () => {
    const missing = [undefined, 1n][0]
    expect(toBigIntIdOrNull(null)).toBeNull()
    expect(toBigIntIdOrNull(missing)).toBeUndefined()
    expect(fromBigIntIdOrNull(null)).toBeNull()
    expect(fromBigIntIdOrNull(missing)).toBeUndefined()
  })

  it('値があれば変換する', () => {
    expect(toBigIntIdOrNull('12')).toBe(12n)
    expect(fromBigIntIdOrNull(12n)).toBe('12')
  })

  it('値があっても不正なら拒否する', () => {
    expect(() => toBigIntIdOrNull('x')).toThrow(InvalidIdError)
  })
})

describe('配列', () => {
  it('順序を保って往復する', () => {
    const ids = ['3', '1', '9223372036854775807']
    expect(fromBigIntIds(toBigIntIds(ids))).toStrictEqual(ids)
  })

  it('空配列は空配列のまま', () => {
    expect(toBigIntIds([])).toStrictEqual([])
    expect(fromBigIntIds([])).toStrictEqual([])
  })

  it('1 要素でも不正なら全体を拒否する', () => {
    expect(() => toBigIntIds(['1', 'x', '3'])).toThrow(InvalidIdError)
  })
})

describe('compareIds', () => {
  it('桁数が違っても数値順に並べる', () => {
    expect(['20', '3', '100', '9'].toSorted(compareIds)).toStrictEqual(['3', '9', '20', '100'])
  })

  it('等しければ 0 を返す', () => {
    expect(compareIds('42', '42')).toBe(0)
  })

  it('同じ桁数なら辞書順で比べる', () => {
    expect(compareIds('1234567890123456788', '1234567890123456789')).toBeLessThan(0)
    expect(compareIds('1234567890123456789', '1234567890123456788')).toBeGreaterThan(0)
  })
})

describe('テスト用 ID 生成', () => {
  it('createSyntheticId は bigint 列に入る範囲の ID を返す', () => {
    for (let index = 0; index < 100; index += 1) {
      const id = createSyntheticId()
      expect(fromBigIntId(toBigIntId(id))).toBe(id)
      expect(BigInt(id) + 1_000_000_000n).toBeLessThanOrEqual(MAX_BIGINT_ID)
    }
  })

  it('createSyntheticSerialId は int4 に入る正の整数を返す', () => {
    for (let index = 0; index < 100; index += 1) {
      const id = createSyntheticSerialId()
      expect(Number.isInteger(id)).toBe(true)
      expect(id).toBeGreaterThanOrEqual(1)
      expect(id).toBeLessThan(2 ** 31)
    }
  })
})
