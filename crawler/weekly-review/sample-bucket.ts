import { createHash } from 'node:crypto'

/**
 * bucket 総数。DB 側の weekly_review_sample_bucket() が下位 12bit を
 * bucket とするため、これと一致させる。
 */
export const BUCKET_COUNT = 4096

/** 母集団サイズに対する候補読み取り件数の倍率。 */
export const OVERSAMPLE_FACTOR = 8

/**
 * accountId から bucket (0..4095) を決定論的に算出する。
 * DB 側の weekly_review_sample_bucket(account_id) と同じ値を返す必要がある。
 * @param accountId - bucket を割り当てる対象の accountId
 * @returns 0..4095 の bucket 番号
 */
export function assignBucket(accountId: string): number {
  const hex = createHash('md5').update(accountId).digest('hex').slice(0, 8)
  return Number.parseInt(hex, 16) & (BUCKET_COUNT - 1)
}

/**
 * 読むべき bucket 数 M を算出する。
 * M = min(4096, ceil(4096 * poolSize * oversampleFactor / populationCount))
 * bucket の疎密で M を増減させないため、選択後の実取得件数は参照しない。
 * @param populationCount - stratum の母集団件数(1 以上)
 * @param poolSize - candidate pool の目標件数 K
 * @param oversampleFactor - 母集団に対する oversample 倍率
 * @returns 読む bucket 数(1..4096)
 */
export function computeBucketReadCount(
  populationCount: number,
  poolSize: number,
  oversampleFactor: number,
): number {
  if (populationCount <= 0) {
    throw new Error(`populationCount must be positive: ${populationCount}`)
  }
  const m = Math.ceil((BUCKET_COUNT * poolSize * oversampleFactor) / populationCount)
  return Math.min(BUCKET_COUNT, Math.max(1, m))
}

/**
 * 決定論的な rank キーを生成する。同じ入力からは常に同じ値を返す。
 * @param parts - rank キーを構成する要素
 * @returns SHA-256 の hex digest
 */
function stableRank(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex')
}

/**
 * 4096 bucket を runId+labelDefinitionId+value+bucket の SHA-256 rank 順に並べ、
 * 先頭 m 個の bucket 番号を返す。
 * @param runId - review run の識別子(seed の一部)
 * @param labelDefinitionId - 対象ラベル定義 ID
 * @param value - 対象ラベル値
 * @param m - 選択する bucket 数
 * @returns 選択された bucket 番号の配列(rank 順ではなく昇順)
 */
export function selectBuckets(
  runId: string,
  labelDefinitionId: string,
  value: boolean,
  m: number,
): number[] {
  const buckets = Array.from({ length: BUCKET_COUNT }, (_, bucket) => bucket)
  const ranked = buckets.toSorted((a, b) =>
    stableRank(runId, labelDefinitionId, String(value), String(a)).localeCompare(
      stableRank(runId, labelDefinitionId, String(value), String(b)),
    ),
  )
  return ranked.slice(0, m).toSorted((a, b) => a - b)
}
