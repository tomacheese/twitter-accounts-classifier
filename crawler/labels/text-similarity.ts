// reply-flooding.ts (単一アカウント内)と reply-hijack-index.ts (複数アカウント間)から共有され、
// いずれも言い換えレベルの文章類似度を測る点は同じで、
// グループ化する軸だけが異なる。
const URL_PATTERN = /https?:\/\/\S+/g
const MENTION_PATTERN = /@\w+/g
const WHITESPACE_PATTERN = /\s+/g
const HASHTAG_PATTERN = /#[^\s#]+/g

export interface SimilarityNormalizationOptions {
  removeHashtags?: boolean
}

/**
 * ペアワイズ類似度比較用にテキストを正規化する。
 * URL と @mention (言い換え間で異なる部分)を除去し、空白を畳んで小文字化する。
 * @param text - ツイートの生本文
 * @returns 正規化後のテキスト
 */
export function normalizeForSimilarity(
  text: string,
  options: SimilarityNormalizationOptions = {},
): string {
  let normalized = text.replaceAll(URL_PATTERN, '').replaceAll(MENTION_PATTERN, '')
  if (options.removeHashtags) normalized = normalized.replaceAll(HASHTAG_PATTERN, '')

  return normalized.replaceAll(WHITESPACE_PATTERN, ' ').trim().toLowerCase()
}

/**
 * `text` 中の文字バイグラム (2文字の部分文字列)集合を構築する。
 *
 * 単語トークンではなく文字バイグラムを用いるのは、日本語は単語間に空白がなく、
 * 単語境界によるトークナイザでは大半の日本語リプライが1トークンとなり、
 * 重なりを検出できなくなるため。
 * @param text - 正規化済みのテキスト
 * @returns バイグラムの集合。1文字の文字列は要素数1の集合になる
 */
export function bigramSet(text: string): Set<string> {
  const bigrams = new Set<string>()
  if (text.length < 2) {
    if (text.length === 1) bigrams.add(text)
    return bigrams
  }
  for (let i = 0; i < text.length - 1; i++) bigrams.add(text.slice(i, i + 2))
  return bigrams
}

/**
 * 2つのバイグラム集合間の Jaccard 類似度 (積集合を和集合で割った値)を計算する。
 * @param a - 1つ目のバイグラム集合
 * @param b - 2つ目のバイグラム集合
 * @returns `[0, 1]` の範囲の値。いずれかの集合が空の場合は0
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const bigram of a) {
    if (b.has(bigram)) intersection++
  }
  return intersection / (a.size + b.size - intersection)
}

/**
 * 各テキストを正規化・バイグラム化したうえで、すべての異なるペアの Jaccard 類似度の平均を計算する。
 * @param texts - ペアワイズ比較する生テキスト
 * @returns ペアワイズ類似度の平均。テキストが2件未満の場合は0
 */
export function averagePairwiseSimilarity(
  texts: string[],
  options: SimilarityNormalizationOptions = {},
): number {
  const bigramSets = texts.map((text) => bigramSet(normalizeForSimilarity(text, options)))
  let total = 0
  let pairs = 0
  for (let i = 0; i < bigramSets.length; i++) {
    for (let j = i + 1; j < bigramSets.length; j++) {
      total += jaccardSimilarity(bigramSets[i], bigramSets[j])
      pairs++
    }
  }
  return pairs === 0 ? 0 : total / pairs
}

// リンクのみの投稿は、言語やトピックに関わらず内容比較上のシグナルを持たない空サンプルにすぎない。
// URL・メンション・自己リツイートの接頭辞を除去し、
// 実質的なテキストが残っている場合のみ「言語的内容を持つ」とみなす。
// reply-language-mismatch と bare-link-spam の両方が、
// この「実質空かどうか」の判定を同じ基準で必要とするため共有する。
export function hasLinguisticContent(text: string): boolean {
  const stripped = text
    .replace(/^RT @\w+:\s*/i, '')
    .replaceAll(/https?:\/\/\S+/gi, '')
    .replaceAll(/@\w+/g, '')
    .trim()
  return stripped.length > 0
}
