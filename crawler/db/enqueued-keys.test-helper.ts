import type { Mock } from 'vitest'

/**
 * enqueueWorkItem が発行する SQL は、先頭 3 つの埋め込み値が論理キー (kind, triggerType, triggerId) になる。
 * `$executeRaw` のモックが受け取ったタグ付きテンプレート呼び出しから、enqueue された論理キーを取り出す。
 * @param executeRaw - `$executeRaw` として差し込んだモック
 * @returns 呼び出し順の論理キー
 */
export function enqueuedKeys(executeRaw: Mock): string[][] {
  return executeRaw.mock.calls.map((call: unknown[]) => call.slice(1, 4) as string[])
}
