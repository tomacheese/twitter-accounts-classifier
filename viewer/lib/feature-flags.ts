/** フラグで個別に切り替えられる新 UI のセクション。 */
export type NewUiSection =
  'overview' | 'review' | 'accounts' | 'labels' | 'operations' | 'blocks' | 'system'

/** 新 UI の全セクション。 */
export const NEW_UI_SECTIONS: NewUiSection[] = [
  'overview',
  'review',
  'accounts',
  'labels',
  'operations',
  'blocks',
  'system',
]

/**
 * `VIEWER_NEW_UI_SECTIONS` (カンマ区切り) に指定された区画かどうかを判定する。
 * 未設定・空文字の場合は新 UI を一切表示しない (旧 UI のみ) 扱いにする。
 * @param section - 判定対象の区画
 * @param env - `VIEWER_NEW_UI_SECTIONS` の値。テスト容易性のため省略時は `process.env` から読む
 * @returns 新 UI を表示すべきなら true
 */
export function isNewUiSectionEnabled(
  section: NewUiSection,
  env = process.env.VIEWER_NEW_UI_SECTIONS,
): boolean {
  if (!env) return false
  return env
    .split(',')
    .map((s) => s.trim())
    .includes(section)
}

/**
 * @param env - `VIEWER_NEW_UI_SECTIONS` の値。テスト容易性のため省略時は `process.env` から読む
 * @returns 有効になっている新 UI のセクション一覧
 */
export function listEnabledNewUiSections(env = process.env.VIEWER_NEW_UI_SECTIONS): NewUiSection[] {
  return NEW_UI_SECTIONS.filter((section) => isNewUiSectionEnabled(section, env))
}
