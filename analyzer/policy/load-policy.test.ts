import { describe, it, expect } from 'vitest'
import { DEFAULT_POLICY_PATH, loadPolicy, recordPolicyVersion } from './load-policy'
import { getPrismaClient } from '../db/client'
import path from 'node:path'

// CommonJS を採用する本プロジェクトでは __dirname がテストファイルの位置を
// 得る素直な手段であり、import.meta は tsconfig の module 設定と両立しない。
// eslint-disable-next-line unicorn/prefer-module
const dirname = __dirname

describe('loadPolicy', () => {
  it('detection-policy.json を検証して読み込める', () => {
    const policy = loadPolicy(path.join(dirname, 'detection-policy.json'))
    expect(policy.rules.length).toBeGreaterThan(0)
    const weeklyTypes = policy.rules
      .filter((rule) => rule.enabled && rule.detectorType === 'weekly_review')
      .map((rule) => rule.type)
    expect(weeklyTypes).toEqual(
      expect.arrayContaining([
        'possible_false_positive',
        'possible_false_negative',
        'rule_behavior_mismatch',
        'review_incomplete',
        'coverage_gap',
        'external_threat_gap',
      ]),
    )
  })

  it('schema 違反があれば例外を投げる', () => {
    expect(() => loadPolicy(path.join(dirname, 'schema.ts'))).toThrow()
  })
})

describe.skipIf(!process.env.DATABASE_URL)('recordPolicyVersion', () => {
  const prisma = getPrismaClient()

  it('適用中の policy を DetectionPolicyVersion として記録する', async () => {
    const policy = loadPolicy(DEFAULT_POLICY_PATH)

    const contentHash = await recordPolicyVersion(prisma, policy)

    const stored = await prisma.detectionPolicyVersion.findUniqueOrThrow({
      where: { policyVersion: policy.policyVersion },
    })
    expect(stored.contentHash).toBe(contentHash)
    expect(stored.schemaVersion).toBe(policy.schemaVersion)
  })

  it('同じ policyVersion で再実行しても行が増えない', async () => {
    const policy = loadPolicy(DEFAULT_POLICY_PATH)

    await recordPolicyVersion(prisma, policy)
    await recordPolicyVersion(prisma, policy)

    const count = await prisma.detectionPolicyVersion.count({
      where: { policyVersion: policy.policyVersion },
    })
    expect(count).toBe(1)
  })
})
