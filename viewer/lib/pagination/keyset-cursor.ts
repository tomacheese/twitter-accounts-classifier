/** encodeCursor の入力。 */
export interface EncodeCursorInput {
  sortValues: string[]
  filterHash: string
}

/**
 * cursor は base64 化した JSON とし、filter・sort の hash を含める。
 * filter が変わった cursor を誤って使い回さないようにするため。
 * @param input - cursor に含めるソート値と filter hash
 * @returns URL に埋め込める不透明な cursor 文字列
 */
export function encodeCursor(input: EncodeCursorInput): string {
  return Buffer.from(JSON.stringify(input)).toString('base64url')
}

/**
 * @param cursor - encodeCursor で生成した cursor 文字列
 * @param expectedFilterHash - 現在の filter/sort 条件から計算した hash
 * @returns cursor が有効かつ filter が一致すればソート値、そうでなければ null
 */
export function decodeCursor(cursor: string, expectedFilterHash: string): string[] | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      !('sortValues' in decoded) ||
      !('filterHash' in decoded)
    ) {
      return null
    }
    const { sortValues, filterHash } = decoded as { sortValues: unknown; filterHash: unknown }
    if (filterHash !== expectedFilterHash || !Array.isArray(sortValues)) return null
    // filterHash は filter の JSON そのもので秘密ではないため、
    // 一致する hash を添えたまま要素だけ差し替えた cursor を作れる。
    // 要素型を見ないと Number()・new Date() が NaN・Invalid Date のまま SQL へ渡る。
    if (!sortValues.every((value) => typeof value === 'string')) return null
    return sortValues
  } catch {
    return null
  }
}
