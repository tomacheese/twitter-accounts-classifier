import { describe, it, expect } from 'vitest'
import { loadPolicy } from './load-policy'
import path from 'node:path'

// CommonJS を採用する本プロジェクトでは __dirname がテストファイルの位置を
// 得る素直な手段であり、import.meta は tsconfig の module 設定と両立しない。
// eslint-disable-next-line unicorn/prefer-module
const dirname = __dirname

describe('loadPolicy', () => {
  it('detection-policy.json を検証して読み込める', () => {
    const policy = loadPolicy(path.join(dirname, 'detection-policy.json'))
    expect(policy.rules.length).toBeGreaterThan(0)
  })

  it('schema 違反があれば例外を投げる', () => {
    expect(() => loadPolicy(path.join(dirname, 'schema.ts'))).toThrow()
  })
})
