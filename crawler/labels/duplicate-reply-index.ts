// URL と @mention を正規化に含めると、
// 短縮 URL やリプライ先が投稿ごとに異なるため、
// 同一テンプレート文言の一致を検出できなくなる。
// そのため両方とも比較前に除去する。
const URL_PATTERN = /https?:\/\/\S+/g
const MENTION_PATTERN = /@\w+/g
const WHITESPACE_PATTERN = /\s+/g

// この文字数未満の正規化後テキストは挨拶などの定型文全般に一致してしまうため、
// 複数アカウント間で一致してもボットネットワークの兆候とはみなさない。
const MIN_NORMALIZED_LENGTH = 20

/**
 * リプライ本文をアカウント横断の重複比較用に正規化する。
 * @param text - ツイートの生本文
 * @returns 正規化後のテキスト。重複検出の signal として意味を持たないほど短い場合は空文字列
 */
export function normalizeReplyText(text: string): string {
  const normalized = text
    .replaceAll(URL_PATTERN, '')
    .replaceAll(MENTION_PATTERN, '')
    .replaceAll(WHITESPACE_PATTERN, ' ')
    .trim()
    .toLowerCase()
  return normalized.length >= MIN_NORMALIZED_LENGTH ? normalized : ''
}

export interface ReplyCorpusEntry {
  accountId: string
  fullText: string
  /** このリプライの返信先ツイート ID。不明な場合は `null`。 */
  inReplyToTweetId: string | null
}

export interface DuplicateReplyIndex {
  /**
   * @param text - 検索対象となるリプライの生本文
   * @param excludeAccountId - 対象のリプライを投稿した本人のアカウント。件数から除外する
   * @returns `excludeAccountId` 以外で、`text` の正規化形と一致するリプライを投稿したアカウントの数。
   *   一致した全リプライが同一ツイート宛てと確認できた場合は、ハッシュタグキャンペーン等の
   *   偶発的一致として 0 を返す
   */
  countOtherAccounts(text: string, excludeAccountId: string): number
}

/**
 * リプライツイートの corpus からアカウント横断の重複リプライ検索用インデックスを構築する。
 * 個々のアカウント単体の bundle だけでは他アカウントとの重複を判定できないため、
 * クロールおよび再ラベリング実行ごとに全アカウント分の corpus からまとめて一度だけ構築する。
 * @param corpus - クロール・再ラベリング実行全体から集めたリプライツイート
 * @returns bundle 構築時にアカウントごとに問い合わせるためのインデックス
 */
export function buildDuplicateReplyIndex(corpus: ReplyCorpusEntry[]): DuplicateReplyIndex {
  const groupsByNormalizedText = new Map<string, { accounts: Set<string>; targets: Set<string> }>()
  for (const entry of corpus) {
    const normalized = normalizeReplyText(entry.fullText)
    if (normalized === '') continue
    const group = groupsByNormalizedText.get(normalized) ?? {
      accounts: new Set<string>(),
      targets: new Set<string>(),
    }
    group.accounts.add(entry.accountId)
    if (entry.inReplyToTweetId !== null) group.targets.add(entry.inReplyToTweetId)
    groupsByNormalizedText.set(normalized, group)
  }

  return {
    countOtherAccounts(text, excludeAccountId) {
      const normalized = normalizeReplyText(text)
      if (normalized === '') return 0
      const group = groupsByNormalizedText.get(normalized)
      if (!group) return 0
      // 既知の返信先がちょうど1件なら、この文面は単一のキャンペーン投稿への返信でのみ
      // 観測されたとみなし、複数スレッドを横断するボットネットワークから除外する。
      // 返信先が1件も分からない corpus では従来の検出挙動を維持する。
      if (group.targets.size === 1) return 0
      return group.accounts.has(excludeAccountId) ? group.accounts.size - 1 : group.accounts.size
    },
  }
}
