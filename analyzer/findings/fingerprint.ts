/**
 * severity、実測値、閾値、policy version、source Run ID、検出日時は
 * 呼び出し側の型定義でそもそも渡せないようにし、fingerprint の安定性を保証する。
 * dimensions のキー順序に依存しないよう、ソート済みキーで正規化する。
 * @param type - 検出ルールの種別 (例: label_count_drop)
 * @param dimensions - fingerprint の同一性を決める次元 (label キーなど)
 * @returns 安定した fingerprint 文字列
 */
export function computeFingerprint(type: string, dimensions: Record<string, string>): string {
  const sortedEntries = Object.entries(dimensions).toSorted(([a], [b]) => a.localeCompare(b))
  const dimensionPart = sortedEntries.map(([key, value]) => `${key}:${value}`).join('+')
  return `${type}+${dimensionPart}`
}
