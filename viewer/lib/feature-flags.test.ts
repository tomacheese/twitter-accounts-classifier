import { describe, it, expect } from 'vitest'
import { isNewUiSectionEnabled } from './feature-flags'

describe('isNewUiSectionEnabled', () => {
  it('環境変数が未設定なら false を返す', () => {
    expect(isNewUiSectionEnabled('overview', undefined)).toBe(false)
  })

  it('環境変数が空文字なら false を返す', () => {
    expect(isNewUiSectionEnabled('overview', '')).toBe(false)
  })

  it('カンマ区切りに含まれる区画なら true を返す', () => {
    expect(isNewUiSectionEnabled('review', 'overview,review,accounts')).toBe(true)
  })

  it('カンマ区切りに含まれない区画なら false を返す', () => {
    expect(isNewUiSectionEnabled('blocks', 'overview,review,accounts')).toBe(false)
  })

  it('区画名の前後の空白を無視する', () => {
    expect(isNewUiSectionEnabled('review', 'overview, review , accounts')).toBe(true)
  })

  it('accounts はロールアウト完了済みのため環境変数に関係なく true', () => {
    expect(isNewUiSectionEnabled('accounts', undefined)).toBe(true)
    expect(isNewUiSectionEnabled('accounts', '')).toBe(true)
    expect(isNewUiSectionEnabled('accounts', 'overview,operations')).toBe(true)
  })
})
