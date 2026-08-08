import { NextResponse } from 'next/server'
import { isNewUiSectionEnabled, type NewUiSection } from './feature-flags'

/**
 * 無効な区画の API を露出させないためのガード。
 * 区画ごとに判定することで、1 つの区画を試験公開しても他の区画まで開かないようにする。
 * @param section - この Route Handler が属する区画
 * @returns 無効なら 404 レスポンス、有効なら null
 */
export function guardSection(section: NewUiSection): NextResponse | null {
  if (isNewUiSectionEnabled(section)) return null
  return NextResponse.json({ error: 'Not Found' }, { status: 404 })
}
