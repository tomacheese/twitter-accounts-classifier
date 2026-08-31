export interface CardLegacyLike {
  bindingValues: { key: string; value: { stringValue?: string } }[]
}

export interface CardLike {
  legacy?: CardLegacyLike
}

export interface CardDestinationUrlsResult {
  urls: string[]
  evaluated: boolean
}

const NOT_EVALUATED: CardDestinationUrlsResult = { urls: [], evaluated: false }
const EVALUATED_EMPTY: CardDestinationUrlsResult = { urls: [], evaluated: true }

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

interface DestinationObject {
  type?: unknown
  data?: { url_data?: { url?: unknown } }
}

function isDestinationObject(value: unknown): value is DestinationObject {
  return typeof value === 'object' && value !== null
}

function extractBrowserUrls(destinationObjects: unknown): string[] | null {
  if (destinationObjects === undefined) return []
  if (typeof destinationObjects !== 'object' || destinationObjects === null) return null

  const entries = Array.isArray(destinationObjects)
    ? destinationObjects
    : Object.values(destinationObjects)

  const urls = new Set<string>()
  for (const entry of entries) {
    if (!isDestinationObject(entry) || entry.type !== 'browser') continue
    const url = entry.data?.url_data?.url
    if (typeof url !== 'string') continue
    const trimmed = url.trim()
    if (isHttpUrl(trimmed)) urls.add(trimmed)
  }
  return [...urls]
}

/**
 * `unified_card` の `stringValue` を JSON parse し、`type === 'browser'` の遷移先 URL だけを抽出する。
 * `card_url` などの制御 URL は `bindingValues` を読まないため対象外になる。
 * JSON parse に失敗した場合や `destination_objects` が期待される object/array 形状でない場合は、
 * 安全に評価できなかったことを示すため `evaluated: false` を返す。
 * @param card - 評価対象ツイートの Card (存在しない場合は undefined)
 * @returns 遷移先 URL の集合と、評価が正常に完了したか
 */
export function extractCardDestinationUrls(card: CardLike | undefined): CardDestinationUrlsResult {
  const bindingValues = card?.legacy?.bindingValues
  if (bindingValues === undefined) return EVALUATED_EMPTY

  const unifiedCard = bindingValues.find((binding) => binding.key === 'unified_card')
  if (unifiedCard === undefined) return EVALUATED_EMPTY

  const stringValue = unifiedCard.value.stringValue
  if (stringValue === undefined) return NOT_EVALUATED

  let parsed: unknown
  try {
    parsed = JSON.parse(stringValue)
  } catch {
    return NOT_EVALUATED
  }
  if (typeof parsed !== 'object' || parsed === null) return NOT_EVALUATED

  const urls = extractBrowserUrls((parsed as { destination_objects?: unknown }).destination_objects)
  if (urls === null) return NOT_EVALUATED
  return { urls, evaluated: true }
}
