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
// 1 件ごとの失敗を握り潰す前提のため、Postgres が transaction 全体を abort 状態にしてしまう
// transaction client を渡してはならない。
/**
 * @param prisma - Prisma クライアント。transaction 内でこの関数を使ってはならない
 * @param result - 取得したフォロー先一覧（1ページ・上限件数分）
 * @returns Account の upsert に成功した followee ID の集合
 */
export async function upsertFollowSampleAuthors(
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
 * 自前で transaction を開始しないため、呼び出し元が `tx as unknown as PrismaClient` を渡せば、
 * 外側の transaction に合成できる。
 * @param prisma - Prisma クライアント (または transaction client)
 * @param accountId - サンプル取得対象のラベリング対象アカウント
 * @param followeeIds - Account の upsert に成功した followee ID 一覧
 */
export async function replaceLabelingFollowSampleWithinTx(
  prisma: PrismaClient,
  accountId: string,
  followeeIds: string[],
): Promise<void> {
  // `./follow-repository` の syncFollowing と同様、
  // result.ids が空だと削除だけが実行されて既存サンプルを全消去してしまうため、
  // 1件以上取得できた場合のみ削除・挿入をまとめて行う。
  if (followeeIds.length === 0) return

  await prisma.labelingFollowSample.deleteMany({ where: { accountId } })
  await prisma.labelingFollowSample.createMany({
    data: followeeIds.map((followeeId) => ({ accountId, followeeId })),
    skipDuplicates: true,
  })
}

/**
 * {@link replaceLabelingFollowSampleWithinTx} を自前の transaction でラップする薄い wrapper。
 * @param prisma - Prisma クライアント
 * @param accountId - サンプル取得対象のラベリング対象アカウント
 * @param result - 取得したフォロー先一覧（1ページ・上限件数分）
 */
export async function replaceLabelingFollowSample(
  prisma: PrismaClient,
  accountId: string,
  result: FollowListResult,
): Promise<void> {
  const upsertedIds = await upsertFollowSampleAuthors(prisma, result)
  // Account の upsert に失敗した followeeId は外部キー制約に違反するため、
  // createMany 全体を巻き添えでロールバックさせないようにここで除外する。
  const followeeIds = result.ids.filter((id) => upsertedIds.has(id))
  if (followeeIds.length === 0) return

  await prisma.$transaction(
    (tx) =>
      replaceLabelingFollowSampleWithinTx(tx as unknown as PrismaClient, accountId, followeeIds),
    // Postgres データ用ボリュームは HDD 上にあり (compose.yaml 参照)、チェックポイントの書き込みが数秒滞留することがある。
    // 既定の 5 秒タイムアウトでは短すぎるため、吸収できる値に伸ばす。
    { maxWait: 15_000, timeout: 15_000 },
  )
}
