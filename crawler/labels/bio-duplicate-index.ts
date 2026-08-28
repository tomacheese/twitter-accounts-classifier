// プロフィール URL やメンション先はアカウントごとに異なるため、
// 正規化に含めると同一テンプレート bio の一致を検出できなくなる。
// そのため両方とも比較前に除去する。
const URL_PATTERN = /https?:\/\/\S+/g
const MENTION_PATTERN = /@\w+/g
const WHITESPACE_PATTERN = /\s+/g

// この文字数未満の正規化後テキストは挨拶などの定型文全般に一致してしまうため、
// 複数アカウント間で一致しても複製ネットワークの兆候とはみなさない。
const MIN_NORMALIZED_LENGTH = 20

/**
 * bio テキストを複製検出用に正規化する。
 * @param text - 正規化対象の bio テキスト
 * @returns 正規化後のテキスト。定型文全般との誤一致を避けるため、
 * 正規化後の長さが `MIN_NORMALIZED_LENGTH` 未満の場合は空文字列を返す。
 */
export function normalizeBioText(text: string): string {
  const normalized = text
    .replaceAll(URL_PATTERN, '')
    .replaceAll(MENTION_PATTERN, '')
    .replaceAll(WHITESPACE_PATTERN, ' ')
    .trim()
    .toLowerCase()
  return normalized.length >= MIN_NORMALIZED_LENGTH ? normalized : ''
}

export interface BioCorpusEntry {
  accountId: string
  bio: string
}

export interface BioDuplicateIndex {
  /**
   * 指定した bio と正規化形で一致する、`excludeAccountId` 以外のアカウント数を返す。
   * @param bio - 比較対象の bio テキスト
   * @param excludeAccountId - 集計から除外する自分自身のアカウント ID
   * @returns 一致する他アカウント数
   */
  countOtherAccounts(bio: string, excludeAccountId: string): number
}

/**
 * bio コーパスから、正規化後 bio ごとのアカウント集合インデックスを構築する。
 * @param corpus - コーパスの (アカウント ID, bio) エントリ一覧
 * @returns 構築されたインデックス
 */
export function buildBioDuplicateIndex(corpus: BioCorpusEntry[]): BioDuplicateIndex {
  const accountsByNormalizedBio = new Map<string, Set<string>>()
  for (const entry of corpus) {
    const normalized = normalizeBioText(entry.bio)
    if (normalized === '') continue
    const accounts = accountsByNormalizedBio.get(normalized) ?? new Set<string>()
    accounts.add(entry.accountId)
    accountsByNormalizedBio.set(normalized, accounts)
  }
  return {
    countOtherAccounts(bio, excludeAccountId) {
      const normalized = normalizeBioText(bio)
      if (normalized === '') return 0
      const accounts = accountsByNormalizedBio.get(normalized)
      if (!accounts) return 0
      return accounts.has(excludeAccountId) ? accounts.size - 1 : accounts.size
    },
  }
}
