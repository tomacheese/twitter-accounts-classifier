import { Logger } from '@book000/node-utils'
import type { PrismaClient } from '../generated/prisma'
import { upsertAccount } from './account-repository'
import type { FollowListResult } from '../twitter/follows'

const logger = Logger.configure('labeling-follow-sample-repository')

// `./follow-repository` の `upsertFollowAuthors` と同様、
// 1件の不正なプロフィールで残りのフォロー先の反映まで止めてはならないため、
// アカウントごとに個別に upsert する。
async function upsertFolloweeAuthors(prisma: PrismaClient, result: FollowListResult): Promise<void> {
  for (const author of result.authors) {
    try {
      await upsertAccount(prisma, author)
    } catch (error) {
      logger.error(
        `Failed to upsert account ${author.id} while sampling labeling follow edges`,
        error as Error,
      )
    }
  }
}

/**
 * 呼び出しごとに既存行を削除してから今回取得した分だけを挿入し直す。
 * `Follow` の蓄積型 upsert とは異なり、
 * フォロー解除された相手が古いサンプルとして残り続けることを避けるため。
 * @param prisma - Prisma クライアント
 * @param accountId - サンプル取得対象のラベリング対象アカウント
 * @param result - 取得したフォロー先一覧（1ページ・上限件数分）
 */
export async function replaceLabelingFollowSample(
  prisma: PrismaClient,
  accountId: string,
  result: FollowListResult,
): Promise<void> {
  await upsertFolloweeAuthors(prisma, result)

  await prisma.$transaction(async (tx) => {
    await tx.labelingFollowSample.deleteMany({ where: { accountId } })
    if (result.ids.length > 0) {
      await tx.labelingFollowSample.createMany({
        data: result.ids.map((followeeId) => ({ accountId, followeeId })),
        skipDuplicates: true,
      })
    }
  })
}
