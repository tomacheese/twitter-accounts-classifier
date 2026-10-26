// 「好きなもの 〇〇・〇〇・〇〇」のような趣味の羅列に混じった 1 語は、
// その話題への関心を示す根拠として弱いため、羅列中の単独一致は除外している。
// 項目数の下限は、2 項目の並記 (「国内・海外旅行」など) を羅列と誤認しないための値。
const SEGMENT_PATTERN = /[^。.\n|｜!！?？]+/g
const ITEM_DELIMITER_PATTERN = /[、,，・/／]/
const MIN_HOBBY_LIST_ITEMS = 3
const MIN_DISTINCT_MENTIONS = 2

/**
 * 話題語の一致が、複数語または趣味の羅列ではない位置での記載として際立っているかを返す。
 * @param bio - 判定対象の bio
 * @param pattern - 話題語の正規表現 (`g` フラグの有無は問わない)
 * @returns 異なる語が 2 種類以上一致するか、羅列ではない位置に一致があれば true
 */
export function hasProminentTopicMention(bio: string, pattern: RegExp): boolean {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const matches = [...bio.matchAll(new RegExp(pattern.source, flags))]
  if (matches.length === 0) return false
  const distinct = new Set(matches.map((match) => match[0].toLowerCase()))
  if (distinct.size >= MIN_DISTINCT_MENTIONS) return true
  const segments = [...bio.matchAll(SEGMENT_PATTERN)]
  return matches.some((match) => {
    const segment = segments.find(
      (candidate) =>
        match.index >= candidate.index && match.index < candidate.index + candidate[0].length,
    )
    if (!segment) return true
    const items = segment[0].split(ITEM_DELIMITER_PATTERN).filter((item) => item.trim() !== '')
    return items.length < MIN_HOBBY_LIST_ITEMS
  })
}
