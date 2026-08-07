import { readFileSync } from 'node:fs'
import { detectionPolicySchema, type DetectionPolicy } from './schema'

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
