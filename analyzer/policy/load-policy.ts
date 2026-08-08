import { readFileSync } from 'node:fs'
import path from 'node:path'
import { detectionPolicySchema, type DetectionPolicy } from './schema'
import { computePolicyHash } from './policy-hash'
import type { Prisma, PrismaClient } from '../generated/prisma'

// CommonJS を採用する本プロジェクトでは __dirname がモジュールの位置を得る素直な手段であり、
// import.meta は tsconfig の module 設定と両立しない。
// eslint-disable-next-line unicorn/prefer-module
export const DEFAULT_POLICY_PATH = path.join(__dirname, 'detection-policy.json')

/**
 * @param filePath - 検証対象の detection policy JSON ファイルパス
 * @returns 検証済みの DetectionPolicy
 */
export function loadPolicy(filePath: string): DetectionPolicy {
  const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
  const result = detectionPolicySchema.safeParse(raw)
  if (!result.success) {
    throw new Error(`invalid detection policy at ${filePath}: ${result.error.message}`)
  }
  return result.data
}

/**
 * 適用中の policy を DetectionPolicyVersion として記録する。
 * policyVersion を据え置いたまま中身だけ書き換えた場合に古い hash が残らないよう、
 * 既存行があれば内容と hash を上書きする。
 * @param prisma - Prisma クライアント
 * @param policy - 適用中の DetectionPolicy
 * @returns 記録した内容の content hash
 */
export async function recordPolicyVersion(
  prisma: PrismaClient,
  policy: DetectionPolicy,
): Promise<string> {
  const contentHash = computePolicyHash(policy)
  const values = {
    contentHash,
    schemaVersion: policy.schemaVersion,
    content: policy as unknown as Prisma.InputJsonValue,
  }

  await prisma.detectionPolicyVersion.upsert({
    where: { policyVersion: policy.policyVersion },
    create: { policyVersion: policy.policyVersion, ...values },
    update: values,
  })

  return contentHash
}
