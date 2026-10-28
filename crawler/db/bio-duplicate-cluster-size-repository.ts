import { createHash } from 'node:crypto'
import type { PrismaClient } from '../generated/prisma'
import { buildBioClusters, type BioCorpusEntry } from '../labels/bio-duplicate-index'
import { MIN_NETWORK_SIZE } from '../labels/rules/bio-duplicate-network'
import { requestAccountRelabelBulk } from './analysis-work-item-repository'
import { filterAccountIdsWithExistingLabels } from './label-repository'

// ルールは自分を除いた人数で判定するため、クラスタ総数では 1 多い値が閾値になる。
const CLUSTER_SIZE_THRESHOLD = MIN_NETWORK_SIZE + 1

export const MAX_CLUSTER_RELABEL_REQUESTS_PER_CYCLE = 500

// bio 本文を DB に残さないため、正規化 bio はハッシュ化して保存する。
function toClusterKey(normalizedBio: string): string {
  return createHash('sha256').update(normalizedBio).digest('hex')
}

interface PersistedCluster {
  size: number
  memberIds: string[]
}

/**
 * 前サイクルのサイズと比較して閾値を跨いだクラスタを検出する。
 * 閾値以上に増えたクラスタと、閾値以上から縮小したクラスタの既存ラベル付きアカウントへ
 * account_relabel を要求したうえで、サイズを永続化する。
 * 縮小したクラスタは、縮小前のメンバー ID を永続化しているものだけを対象にする。
 * 永続サイズが空の初回は比較対象がないため、要求せず永続化だけ行う。
 * @param prisma - Prisma クライアント
 * @param corpus - サイクル末時点の bio コーパス
 * @param limit - 今回要求するアカウント数の上限
 * @returns 要求したアカウント数
 */
export async function relabelGrownBioClusters(
  prisma: PrismaClient,
  corpus: BioCorpusEntry[],
  limit: number = MAX_CLUSTER_RELABEL_REQUESTS_PER_CYCLE,
): Promise<number> {
  const clusters = new Map<string, string[]>()
  for (const [normalizedBio, accountIds] of buildBioClusters(corpus)) {
    clusters.set(toClusterKey(normalizedBio), accountIds)
  }

  const previousRows = await prisma.bioDuplicateClusterSize.findMany()
  const previous = new Map<string, PersistedCluster>(
    previousRows.map((row) => [row.clusterKey, { size: row.size, memberIds: row.memberIds }]),
  )

  // 閾値未満のクラスタは縮小検出の対象にならないため、メンバー ID を保存しない。
  const persisted = new Map<string, PersistedCluster>()
  for (const [key, accountIds] of clusters) {
    const memberIds = accountIds.length >= CLUSTER_SIZE_THRESHOLD ? accountIds : []
    persisted.set(key, { size: accountIds.length, memberIds })
  }

  let requested = 0
  if (previous.size > 0) {
    for (const [key, accountIds] of clusters) {
      const before = previous.get(key)
      const beforeSize = before?.size ?? 0
      if (beforeSize >= CLUSTER_SIZE_THRESHOLD || accountIds.length < CLUSTER_SIZE_THRESHOLD) {
        continue
      }
      const labeled = [...(await filterAccountIdsWithExistingLabels(prisma, accountIds))]
      if (requested + labeled.length > limit) {
        // 一部だけ要求すると残りを次サイクルで拾えないため、クラスタ単位で全件か 0 件にする。
        // 前回サイズを据え置けば、次サイクルでも閾値超えとして再び対象になる。
        if (before === undefined) persisted.delete(key)
        else persisted.set(key, before)
        continue
      }
      await requestAccountRelabelBulk(prisma, labeled)
      requested += labeled.length
    }

    for (const [key, before] of previous) {
      if (before.size < CLUSTER_SIZE_THRESHOLD || before.memberIds.length === 0) continue
      if ((clusters.get(key)?.length ?? 0) >= CLUSTER_SIZE_THRESHOLD) continue
      const labeled = [...(await filterAccountIdsWithExistingLabels(prisma, before.memberIds))]
      if (labeled.length === 0) continue
      if (requested + labeled.length > limit) {
        // 縮小後はクラスタ自体が消えうるため、前回の行を戻さないと次サイクルで検出できない。
        persisted.set(key, before)
        continue
      }
      await requestAccountRelabelBulk(prisma, labeled)
      requested += labeled.length
    }
  }

  await prisma.$transaction([
    prisma.bioDuplicateClusterSize.deleteMany(),
    prisma.bioDuplicateClusterSize.createMany({
      data: [...persisted].map(([clusterKey, row]) => ({ clusterKey, ...row })),
    }),
  ])
  return requested
}
