import { createHash } from 'node:crypto'

/**
 * キー順序に依存しない安定した JSON 表現を作ってから SHA-256 を取る。
 * policyVersion 文字列は運用者が更新を忘れる可能性があるため、
 * 内容そのものの hash を正本の同一性判定に使う。
 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalize(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, normalize(v)]),
    )
  }
  return value
}

/**
 * policy の内容から content hash を計算する。
 * @param policy - hash 対象の policy
 * @returns SHA-256 の hex 文字列
 */
export function computePolicyHash(policy: unknown): string {
  const normalized = normalize(policy)
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}
