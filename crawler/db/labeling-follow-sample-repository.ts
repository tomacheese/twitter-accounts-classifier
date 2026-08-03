import { Logger } from '@book000/node-utils'
import type { PrismaClient } from '../generated/prisma'
import { upsertAccount } from './account-repository'
import type { FollowListResult } from '../twitter/follows'

const logger = Logger.configure('labeling-follow-sample-repository')

// `./follow-repository` の `upsertFollowAuthors` と同様、
// 1件の不正なプロフィールで残りのフォロー先の反映まで止めてはならないため、
// アカウントごとに個別に upsert する。
// upsert に失敗したアカウントの id は戻り値から除外し、
// 呼び出し元が LabelingFollowSample の外部キー違反を避けられるようにする。
async function upsertFolloweeAuthors(
  prisma: PrismaClient,
  result: FollowListResult,
): Promise<Set<string>> {
  const upsertedIds = new Set<string>()
  for (const author of result.authors) {
    try {
      await upsertAccount(prisma, author)
      upsertedIds.add(author.id)
    } catch (error) {
      logger.error(
        `Failed to upsert account ${author.id} while sampling labeling follow edges`,
        error as Error,
      )
    }
  }
  return upsertedIds
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
  const upsertedIds = await upsertFolloweeAuthors(prisma, result)
  // Account の upsert に失敗した followeeId は外部キー制約に違反するため、
  // createMany 全体を巻き添えでロールバックさせないようにここで除外する。
  const followeeIds = result.ids.filter((id) => upsertedIds.has(id))

  // `./follow-repository` の syncFollowing と同様、
  // result.ids が空だと削除だけが実行されて既存サンプルを全消去してしまうため、
  // 1件以上取得できた場合のみ削除・挿入をまとめて行う。
  if (followeeIds.length === 0) return

  await prisma.$transaction(async (tx) => {
    await tx.labelingFollowSample.deleteMany({ where: { accountId } })
    await tx.labelingFollowSample.createMany({
      data: followeeIds.map((followeeId) => ({ accountId, followeeId })),
      skipDuplicates: true,
    })
  })
}
