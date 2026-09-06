import type { Prisma } from '../generated/prisma'
import type { LabelAtWatermark } from './build-account-summary-latest-row'

/** `AccountClassificationObservation.classificationSnapshot` として現状サポートするバージョン。 */
export const SUPPORTED_ACCOUNT_CLASSIFICATION_SNAPSHOT_VERSION = 1

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `AccountClassificationObservation.classificationSnapshot` (Prisma `Json`) を
 * `LabelAtWatermark` 相当の配列へ変換する。crawl 経路が書き込む形状は固定のため、
 * zod 等の追加ライブラリは導入せず型ガードのみで検証する。
 * @param accountId - 対象アカウント (snapshot 自体は accountId を持たないため補う)
 * @param snapshot - `AccountClassificationObservation.classificationSnapshot`
 * @returns watermark 復元と同じ形状のラベル値一覧
 * @throws 配列でない、または要素が必須フィールドを欠く場合
 */
export function parseClassificationSnapshot(
  accountId: string,
  snapshot: Prisma.JsonValue,
): LabelAtWatermark[] {
  if (!Array.isArray(snapshot)) {
    throw new TypeError('classificationSnapshot must be an array')
  }
  return snapshot.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.labelDefinitionId !== 'string' ||
      typeof entry.value !== 'boolean' ||
      typeof entry.confidence !== 'number' ||
      typeof entry.reason !== 'string' ||
      typeof entry.method !== 'string' ||
      typeof entry.ruleVersion !== 'string' ||
      typeof entry.evaluable !== 'boolean' ||
      typeof entry.labeledAt !== 'string'
    ) {
      throw new TypeError(`classificationSnapshot[${index}] is missing a required field`)
    }
    return {
      accountId,
      labelDefinitionId: entry.labelDefinitionId,
      value: entry.value,
      confidence: entry.confidence,
      reason: entry.reason,
      method: entry.method,
      ruleVersion: entry.ruleVersion,
      evaluable: entry.evaluable,
      labeledAt: new Date(entry.labeledAt),
    }
  })
}
