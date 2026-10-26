/**
 * Postgres の text・jsonb は NUL (U+0000) を保持できないため、取り込み境界で NUL のみを除去する。
 * 他の制御文字は検出ルールの入力として意味を持ちうるため残す。
 * @param value - 外部由来の文字列。null と undefined はそのまま返す
 * @returns NUL を除いた文字列
 */
export function stripNul<T extends string | null | undefined>(value: T): T {
  if (typeof value !== 'string') return value
  return value.replaceAll('\u0000', '') as T
}
