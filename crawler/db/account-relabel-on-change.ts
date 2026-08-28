import type { PrismaClient } from '../generated/prisma'
import {
  upsertAccount,
  type AccountProfileInput,
  type UpsertAccountResult,
} from './account-repository'
import { filterAccountIdsWithExistingLabels } from './label-repository'
import { requestAccountRelabel } from './analysis-work-item-repository'

/**
 * Account を upsert し、ラベル評価に影響するフィールドが変化していて、
 * かつ既存ラベルを持つ account であれば account_relabel を要求する。
 * profile 更新自体をこの account の label 評価に直結させない経路
 * (context/fallback author の upsert など) で、変化の取りこぼしを防ぐために使う。
 * @param prisma - Prisma クライアント (transaction client も可)
 * @param input - 正規化済みのアカウントプロフィール
 * @returns upsert 結果
 */
export async function upsertAccountRequestingRelabelIfChanged(
  prisma: PrismaClient,
  input: AccountProfileInput,
): Promise<UpsertAccountResult> {
  const result = await upsertAccount(prisma, input, { detectChange: true })
  if (!result.changed) return result
  const relabelable = await filterAccountIdsWithExistingLabels(prisma, [result.account.id])
  if (relabelable.has(result.account.id)) {
    await requestAccountRelabel(prisma, result.account.id)
  }
  return result
}
