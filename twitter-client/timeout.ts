/** {@link withTimeout} が上限時間内に内側の Promise が settle しなかった場合に投げるエラー。 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

/**
 * `promise` が `timeoutMs` 以内に settle しなければ `TimeoutError` で reject する。
 * `promise` 自体は取り消せないため、settle しない場合でも実行は裏で継続する。
 * 呼び出し元は timeout 発生時に必要な後始末 (例: 子プロセスの強制終了) を別途行う必要がある。
 * @param promise - 上限時間を設ける対象の Promise
 * @param timeoutMs - 上限時間 (ミリ秒)
 * @param timeoutMessage - timeout 発生時の `TimeoutError` メッセージ
 * @returns `promise` の解決値
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  // Promise の executor は同期的に実行されるため、この時点で必ず代入済みになる。
  let timer!: NodeJS.Timeout
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(timeoutMessage))
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timer)
  }
}
