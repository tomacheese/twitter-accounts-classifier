/**
 * テストで Map から値を取り出す。値が無いときは、黙って undefined を渡さず、キーを示して失敗させる。
 * @param map - 取り出し元
 * @param key - 取り出すキー
 * @returns キーに対応する値
 */
export function getOrThrow<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key)
  if (value === undefined) throw new Error(`Map has no entry for key ${String(key)}`)
  return value
}
