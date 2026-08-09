const MIN_DISPLAYABLE_PERCENTAGE = 0.1

/**
 * 小数点 1 桁表示では 0.0% に潰れてしまう極小の非ゼロ値を、
 * ラベル間で見分けられるよう "< 0.1%" として表示する。
 * @param ratio - 0 から 1 の比率 (prevalence または coverage)
 * @returns 表示用の文字列
 */
export function formatPercentage(ratio: number): string {
  const percentage = ratio * 100
  if (percentage > 0 && percentage < MIN_DISPLAYABLE_PERCENTAGE) {
    return `< ${MIN_DISPLAYABLE_PERCENTAGE.toFixed(1)}%`
  }
  return `${percentage.toFixed(1)}%`
}
