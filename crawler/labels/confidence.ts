function validateBetaBinomialInputs(
  successCount: number,
  totalCount: number,
  priorAlpha: number,
  priorBeta: number,
): void {
  if (totalCount < successCount) {
    throw new RangeError(`totalCount (${totalCount}) must be >= successCount (${successCount})`)
  }
  if (priorAlpha < 0 || priorBeta < 0) {
    throw new RangeError('priorAlpha and priorBeta must be non-negative')
  }
}

// Lanczos 近似によるガンマ関数の対数。
const LANCZOS_G = 7
const LANCZOS_COEFFICIENTS = [
  0.999_999_999_999_809_93, 676.520_368_121_885_1, -1259.139_216_722_402_8, 771.323_428_777_653_13,
  -176.615_029_162_140_59, 12.507_343_278_686_905, -0.138_571_095_265_720_12,
  9.984_369_578_019_572e-6, 1.505_632_735_149_311_6e-7,
]

function logGamma(z: number): number {
  if (z < 0.5) {
    // 反射公式: Gamma(z)Gamma(1-z) = pi / sin(pi*z)
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z)
  }
  const zShifted = z - 1
  let x = LANCZOS_COEFFICIENTS[0]
  for (let i = 1; i < LANCZOS_G + 2; i++) {
    x += LANCZOS_COEFFICIENTS[i] / (zShifted + i)
  }
  const t = zShifted + LANCZOS_G + 0.5
  return 0.5 * Math.log(2 * Math.PI) + (zShifted + 0.5) * Math.log(t) - t + Math.log(x)
}

const CONTINUED_FRACTION_MAX_ITERATIONS = 200
const CONTINUED_FRACTION_EPSILON = 1e-12
const CONTINUED_FRACTION_MIN_DENOMINATOR = 1e-300

function betaContinuedFraction(x: number, a: number, b: number): number {
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < CONTINUED_FRACTION_MIN_DENOMINATOR) d = CONTINUED_FRACTION_MIN_DENOMINATOR
  d = 1 / d
  let h = d

  for (let m = 1; m <= CONTINUED_FRACTION_MAX_ITERATIONS; m++) {
    const m2 = 2 * m
    const evenNumerator = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + evenNumerator * d
    if (Math.abs(d) < CONTINUED_FRACTION_MIN_DENOMINATOR) d = CONTINUED_FRACTION_MIN_DENOMINATOR
    c = 1 + evenNumerator / c
    if (Math.abs(c) < CONTINUED_FRACTION_MIN_DENOMINATOR) c = CONTINUED_FRACTION_MIN_DENOMINATOR
    d = 1 / d
    h *= d * c

    const oddNumerator = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + oddNumerator * d
    if (Math.abs(d) < CONTINUED_FRACTION_MIN_DENOMINATOR) d = CONTINUED_FRACTION_MIN_DENOMINATOR
    c = 1 + oddNumerator / c
    if (Math.abs(c) < CONTINUED_FRACTION_MIN_DENOMINATOR) c = CONTINUED_FRACTION_MIN_DENOMINATOR
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < CONTINUED_FRACTION_EPSILON) break
  }
  return h
}

/**
 * 正則化不完全ベータ関数 I_x(a, b)。継続分数法 (Numerical Recipes 由来の標準的な実装) で計算する。
 * @param x - 積分上限 [0, 1]
 * @param a - 形状パラメータ
 * @param b - 形状パラメータ
 * @returns I_x(a, b) [0, 1]
 */
function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1

  if (x < (a + 1) / (a + b + 2)) {
    const logBeta = logGamma(a) + logGamma(b) - logGamma(a + b)
    const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBeta) / a
    return front * betaContinuedFraction(x, a, b)
  }
  // 対称性 I_x(a, b) = 1 - I_1-x(b, a) を使い、継続分数が収束しやすい側で評価する。
  const logBeta = logGamma(a) + logGamma(b) - logGamma(a + b)
  const front = Math.exp(b * Math.log(1 - x) + a * Math.log(x) - logBeta) / b
  return 1 - front * betaContinuedFraction(1 - x, b, a)
}

/**
 * Beta(priorAlpha + successCount, priorBeta + totalCount - successCount) の平均による比率の点推定。
 * 少数サンプルを 0.5 寄りに縮小するが、これは校正済み確率ではなく比率推定値である。
 * 「ratio >= threshold」のような閾値判定には使わず、2つの比率の差を取る、などの閾値を伴わない比較の材料としてのみ使う。
 * @param successCount - 観測された成功回数
 * @param totalCount - 観測された総試行回数
 * @param priorAlpha - 事前分布の alpha パラメータ (省略時 1、Bernoulli rate に対する一様事前分布)
 * @param priorBeta - 事前分布の beta パラメータ (省略時 1)
 * @returns 平滑化された比率推定値 [0, 1]
 */
export function smoothedRate(
  successCount: number,
  totalCount: number,
  priorAlpha = 1,
  priorBeta = 1,
): number {
  validateBetaBinomialInputs(successCount, totalCount, priorAlpha, priorBeta)
  const alpha = priorAlpha + successCount
  const beta = priorBeta + totalCount - successCount
  return alpha / (alpha + beta)
}

/**
 * 観測された比率の真値が threshold 以上である事後確率 P(p >= threshold | successCount, totalCount)。
 * Beta(priorAlpha + successCount, priorBeta + totalCount - successCount) の生存関数として、
 * 正則化不完全ベータ関数の継続分数近似により計算する。
 * 「ratio >= threshold」型の判定境界を持つルール (follow graph、ad_reply_hijack など) の evidenceScore はこちらを使う。
 * successCount/totalCount が threshold ちょうどのとき、概ね 0.5 前後を返す
 * (n が極端に小さい場合を除き、判定境界とおおむね整合する)。
 * @param successCount - 観測された成功回数
 * @param totalCount - 観測された総試行回数
 * @param threshold - 判定閾値 [0, 1]
 * @param priorAlpha - 事前分布の alpha パラメータ (省略時 1)
 * @param priorBeta - 事前分布の beta パラメータ (省略時 1)
 * @returns P(p >= threshold) [0, 1]
 */
export function posteriorProbabilityAtLeast(
  successCount: number,
  totalCount: number,
  threshold: number,
  priorAlpha = 1,
  priorBeta = 1,
): number {
  validateBetaBinomialInputs(successCount, totalCount, priorAlpha, priorBeta)
  if (threshold < 0 || threshold > 1) {
    throw new RangeError(`threshold must be within [0, 1], got ${threshold}`)
  }
  const alpha = priorAlpha + successCount
  const beta = priorBeta + totalCount - successCount
  // P(p >= threshold) = 1 - I_threshold(alpha, beta)
  return 1 - regularizedIncompleteBeta(threshold, alpha, beta)
}

/**
 * 観測値がしきい値をどれだけ上回っている/下回っているかを [0, 1] の evidenceScore へ変換する。
 * value が threshold と一致する点で必ず 0.5 を返し、rampWidth 分だけ超過/不足すると 0 または 1 に飽和する。校正された確率ではない。
 * @param value - 観測値
 * @param threshold - value 判定に使う既存の閾値
 * @param rampWidth - 0.5 から 0 または 1 まで遷移する幅
 * @param direction - 値が大きいほど陽性方向か (省略時 'higher-is-positive')
 * @returns evidenceScore [0, 1]
 */
export function rampScore(
  value: number,
  threshold: number,
  rampWidth: number,
  direction: 'higher-is-positive' | 'lower-is-positive' = 'higher-is-positive',
): number {
  const signedGap = direction === 'higher-is-positive' ? value - threshold : threshold - value
  if (rampWidth <= 0) return signedGap >= 0 ? 1 : 0
  const ratio = signedGap / rampWidth
  return Math.min(1, Math.max(0, 0.5 + ratio * 0.5))
}

/**
 * 必須条件 (AND) の合成。独立性は仮定せず、最も弱い証拠が全体を律する (Math.min)。
 * 各入力が「その条件自身の閾値を満たした結果の rampScore/posteriorProbabilityAtLeast」であれば 0.5 以上になるため、
 * 全条件を満たす (value=true になる) ケースでは常に 0.5 以上を返す。
 * @param scores - 各条件の evidenceScore
 * @returns 合成後の evidenceScore
 */
export function combineRequired(scores: number[]): number {
  return Math.min(...scores)
}

/**
 * 代替条件 (OR) の合成。独立性は仮定せず、最も強い証拠を採用する (Math.max)。
 * 相関し得る複数シグナルを確率の union として合成する (noisy-OR 的な) やり方は、
 * 実際には独立でないシグナルに対して過大な確信度を生むため採用しない。
 * @param scores - 各条件の evidenceScore
 * @returns 合成後の evidenceScore
 */
export function combineAlternatives(scores: number[]): number {
  return Math.max(...scores)
}

/**
 * evidenceScore (value=true 方向の証拠の強さ) を、実際の value に応じて「value が正しいと考えられる度合い」の confidence へ変換する。
 * value=false 側では証拠が無いほど 1 に近づく (陽性の気配が無いこと自体が陰性の根拠になるため)。
 * evaluable=false (判定に足るサンプルが無く、判定自体が信頼できない) の場合は value/evidenceScore を無視して常に 0.5 (「分からない」を表す中立値) を返す。
 * evaluable を省略した場合は true として扱い、通常どおり value/evidenceScore から算出する。
 * @param value - ルールの判定結果
 * @param evidenceScore - value=true 方向の証拠の強さ [0, 1]
 * @param evaluable - 判定材料が十分にあるか (省略時 true)
 * @returns confidence [0, 1]
 */
export function toConfidence(value: boolean, evidenceScore: number, evaluable = true): number {
  if (!evaluable) return 0.5
  return value ? evidenceScore : 1 - evidenceScore
}
