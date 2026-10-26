import { createHash } from 'node:crypto'
import type { PrismaClient } from '../generated/prisma'
import { buildBioClusters, type BioCorpusEntry } from '../labels/bio-duplicate-index'
import { MIN_NETWORK_SIZE } from '../labels/rules/bio-duplicate-network'
import { requestAccountRelabelBulk } from './analysis-work-item-repository'
import { filterAccountIdsWithExistingLabels } from './label-repository'

export const MAX_CLUSTER_RELABEL_REQUESTS_PER_CYCLE = 500

// bio 本文を DB に残さないため、正規化 bio はハッシュ化して保存する。
function toClusterKey(normalizedBio: string): string {
  return createHash('sha256').update(normalizedBio).digest('hex')
}

/**
 * 前サイクルの永続サイズと今サイクルのサイズを比較し、MIN_NETWORK_SIZE を跨いだクラスタの
 * 既存ラベル付きアカウントへ account_relabel を要求したうえで、サイズを永続化する。
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
  const previous = new Map(previousRows.map((row) => [row.clusterKey, row.size]))

  const persisted = new Map<string, number>()
  for (const [key, accountIds] of clusters) persisted.set(key, accountIds.length)

  let requested = 0
  if (previous.size > 0) {
    for (const [key, accountIds] of clusters) {
      const before = previous.get(key) ?? 0
      if (before >= MIN_NETWORK_SIZE || accountIds.length < MIN_NETWORK_SIZE) continue
      const labeled = [...(await filterAccountIdsWithExistingLabels(prisma, accountIds))]
      if (requested + labeled.length > limit) {
        // 一部だけ要求すると残りを次サイクルで拾えないため、クラスタ単位で全件か 0 件にする。
        // 前回サイズを据え置けば、次サイクルでも閾値超えとして再び対象になる。
        if (before === 0) persisted.delete(key)
        else persisted.set(key, before)
        continue
      }
      await requestAccountRelabelBulk(prisma, labeled)
      requested += labeled.length
    }
  }

  await prisma.$transaction([
    prisma.bioDuplicateClusterSize.deleteMany(),
    prisma.bioDuplicateClusterSize.createMany({
      data: [...persisted].map(([clusterKey, size]) => ({ clusterKey, size })),
    }),
  ])
  return requested
}
