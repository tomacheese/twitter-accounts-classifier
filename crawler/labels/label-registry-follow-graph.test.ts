import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALL_LABEL_RULES } from './all-rules'

describe('LabelRule.usesFollowGraphSignal registry consistency', () => {
  it('marks exactly the rules whose source calls hasFollowGraphTopicSignal, and no others', () => {
    // ルールファイル自身の import 元を調べて、フラグの取り忘れ・過剰付与の両方向を検出する。
    // tsconfig の module は CommonJS のため import.meta は使えない。
    // eslint-disable-next-line unicorn/prefer-module
    const rulesDir = path.join(__dirname, 'rules')
    const callsFollowGraphSignal = new Set(
      readdirSync(rulesDir)
        .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
        .filter((file) =>
          readFileSync(path.join(rulesDir, file), 'utf8').includes('hasFollowGraphTopicSignal'),
        )
        .map((file) => file.replace(/\.ts$/, '').replaceAll('-', '_')),
    )

    const flagged = new Set(
      ALL_LABEL_RULES.filter((rule) => rule.usesFollowGraphSignal).map((rule) => rule.key),
    )

    expect(flagged).toEqual(callsFollowGraphSignal)
  })
})
