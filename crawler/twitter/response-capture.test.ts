import { describe, expect, it, vi } from 'vitest'
import { getLastResponseMatching, wrapFetchWithResponseCapture } from './response-capture'

// キャプチャ用バッファはこのファイル内の全テストで共有されるモジュールレベルの状態のため、
// 各テストは前のテストのエントリを読んでしまわないよう、
// それぞれ固有の URL 部分文字列を使っている。

describe('wrapFetchWithResponseCapture', () => {
  it('captures a response url/status/body without altering what the caller receives', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    const wrapped = wrapFetchWithResponseCapture(fetchImpl as unknown as typeof fetch)

    const response = await wrapped('https://x.com/graphql/abc/CaptureBasicTest')

    expect(await response.text()).toBe('{"ok":true}')

    const captured = getLastResponseMatching('CaptureBasicTest')
    expect(captured).toMatchObject({
      url: 'https://x.com/graphql/abc/CaptureBasicTest',
      status: 200,
      body: '{"ok":true}',
    })
    expect(captured?.capturedAt).toBeInstanceOf(Date)
  })

  it('returns undefined from getLastResponseMatching when no response matches', () => {
    expect(getLastResponseMatching('NoSuchEndpointEver')).toBeUndefined()
  })

  it('finds the most recent match by substring, searching from most-recent backward', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('first', { status: 200 }))
      .mockResolvedValueOnce(new Response('second', { status: 200 }))
    const wrapped = wrapFetchWithResponseCapture(fetchImpl as unknown as typeof fetch)

    await wrapped('https://x.com/graphql/abc/MostRecentMatchTest')
    await wrapped('https://x.com/graphql/abc/MostRecentMatchTest')

    const captured = getLastResponseMatching('MostRecentMatchTest')
    expect(captured?.body).toBe('second')
  })

  it('evicts the oldest entry once the buffer exceeds its cap', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation((input: string) => Promise.resolve(new Response(input, { status: 200 })))
    const wrapped = wrapFetchWithResponseCapture(fetchImpl as unknown as typeof fetch)

    // バッファの上限は 20 件のため、
    // URL が異なる 25 件を積むと先頭 5 件が追い出され、
    // EvictionTest-5..24 だけが残るはず。
    for (let i = 0; i < 25; i++) {
      await wrapped(`https://x.com/graphql/abc/EvictionTest-${String(i)}`)
    }

    expect(getLastResponseMatching('EvictionTest-0')).toBeUndefined()
    expect(getLastResponseMatching('EvictionTest-4')).toBeUndefined()
    expect(getLastResponseMatching('EvictionTest-24')).toMatchObject({
      url: 'https://x.com/graphql/abc/EvictionTest-24',
    })
  })

  it('truncates a body past the cap length and appends a truncation marker', async () => {
    const oversizedBody = 'a'.repeat(25_000)
    const fetchImpl = vi.fn().mockResolvedValue(new Response(oversizedBody, { status: 200 }))
    const wrapped = wrapFetchWithResponseCapture(fetchImpl as unknown as typeof fetch)

    await wrapped('https://x.com/graphql/abc/TruncationTest')

    const captured = getLastResponseMatching('TruncationTest')
    expect(captured?.body.length).toBeLessThan(oversizedBody.length)
    expect(captured?.body.endsWith('... [truncated]')).toBe(true)
  })
})
