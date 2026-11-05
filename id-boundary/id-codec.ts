/** PostgreSQL の bigint が取りうる最大値 (19 桁)。 */
export const MAX_BIGINT_ID = 9_223_372_036_854_775_807n

/** 先頭ゼロを許すと文字列へ戻したときに値が変わり、往復の同一性が崩れるため認めない。 */
const ID_PATTERN = /^(?:0|[1-9]\d{0,18})$/

function describe(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value)
  const shown = text.length > 40 ? `${text.slice(0, 40)}...` : text
  return `${typeof value} "${shown}"`
}

/** ID として解釈できない値を境界に渡したときに投げる。 */
export class InvalidIdError extends Error {
  constructor(value: unknown, reason: string) {
    super(`Invalid id ${describe(value)}: ${reason}`)
    this.name = 'InvalidIdError'
  }
}

/**
 * ID の文字列表現を bigint に変換する。
 * 数値型は精度を失いうるため、安全な整数のみ受け付ける。
 * @param value 10 進の文字列、bigint、または安全な整数
 * @returns bigint の ID
 * @throws {InvalidIdError} 非数値、負数、先頭ゼロ、bigint の範囲外
 */
export function toBigIntId(value: string | number | bigint): bigint {
  let id: bigint
  if (typeof value === 'string') {
    if (!ID_PATTERN.test(value)) {
      throw new InvalidIdError(value, 'must be a decimal integer without leading zeros')
    }
    id = BigInt(value)
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new InvalidIdError(value, 'number must be a safe integer')
    }
    id = BigInt(value)
  } else if (typeof value === 'bigint') {
    id = value
  } else {
    throw new InvalidIdError(value, 'must be a string, number or bigint')
  }
  if (id < 0n || id > MAX_BIGINT_ID) {
    throw new InvalidIdError(value, 'out of the bigint id range')
  }
  return id
}

/**
 * bigint の ID を 10 進の文字列に戻す。
 * @param value bigint の ID
 * @returns 10 進の文字列
 */
export function fromBigIntId(value: bigint): string {
  return value.toString(10)
}

/** null と undefined はそのまま返し、それ以外を toBigIntId で変換する。 */
export function toBigIntIdOrNull(value: string | number | bigint): bigint
export function toBigIntIdOrNull(value: null): null
export function toBigIntIdOrNull(
  value: string | number | bigint | null | undefined,
): bigint | null | undefined
export function toBigIntIdOrNull(
  value: string | number | bigint | null | undefined,
): bigint | null | undefined {
  return value === null || value === undefined ? value : toBigIntId(value)
}

/** null と undefined はそのまま返し、それ以外を fromBigIntId で変換する。 */
export function fromBigIntIdOrNull(value: bigint): string
export function fromBigIntIdOrNull(value: null): null
export function fromBigIntIdOrNull(value: bigint | null | undefined): string | null | undefined
export function fromBigIntIdOrNull(value: bigint | null | undefined): string | null | undefined {
  return value === null || value === undefined ? value : fromBigIntId(value)
}

/**
 * ID の配列を bigint の配列に変換する。要素が 1 つでも不正なら全体を拒否する。
 * @param values ID の配列
 * @returns bigint の配列
 */
export function toBigIntIds(values: readonly (string | number | bigint)[]): bigint[] {
  return values.map((value) => toBigIntId(value))
}

/**
 * 10 進文字列の ID を、bigint 列の並び (数値順) と同じ順序で比較する。
 * 文字列の辞書順 (localeCompare) は桁数が違うと数値順と食い違うため使わない。
 * ID は先頭ゼロを持たないので、桁数、同じ桁数なら辞書順で数値順になる。
 * @param left - 10 進文字列の ID
 * @param right - 10 進文字列の ID
 * @returns left が小さければ負、大きければ正、等しければ 0
 */
export function compareIds(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * テストデータ用に、衝突しにくい 19 桁以内の ID を作る。本番コードでは使わない。
 * @returns 10 進文字列の ID
 */
export function createSyntheticId(): string {
  return String(BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 1_000_000)))
}

/**
 * テストデータ用に、int4 の識別子列 (WorkItem や Run など) へ入れられる衝突しにくい値を作る。本番コードでは使わない。
 * @returns 1 以上 2^31 未満の整数
 */
export function createSyntheticSerialId(): number {
  return 1 + Math.floor(Math.random() * 2_000_000_000)
}

/**
 * bigint の配列を文字列の配列に戻す。
 * @param values bigint の配列
 * @returns 10 進文字列の配列
 */
export function fromBigIntIds(values: readonly bigint[]): string[] {
  return values.map((value) => fromBigIntId(value))
}
