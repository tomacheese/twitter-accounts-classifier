import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getAccountOverview, getAccountClassification } = vi.hoisted(() => ({
  getAccountOverview: vi.fn(),
  getAccountClassification: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ getPrismaClient: () => ({}) }))
vi.mock('@/lib/queries/account-subviews', () => ({
  getAccountOverview,
  getAccountClassification,
  getAccountEvidence: vi.fn(),
  getAccountRelations: vi.fn(),
  getAccountHistory: vi.fn(),
  getAccountTechnical: vi.fn(),
}))

const { GET } = await import('./route')

function callGet(accountId: string, subview: string) {
  return GET(new Request('http://localhost/api'), {
    params: Promise.resolve({ accountId, subview }),
  })
}

const originalEnv = process.env.VIEWER_NEW_UI_SECTIONS

beforeEach(() => {
  vi.clearAllMocks()
  process.env.VIEWER_NEW_UI_SECTIONS = 'accounts'
})

afterEach(() => {
  process.env.VIEWER_NEW_UI_SECTIONS = originalEnv
})

describe('GET /api/accounts/[accountId]/[subview]', () => {
  it('既知の subview はデータを 200 で返す', async () => {
    getAccountOverview.mockResolvedValue({ accountId: 'account-1' })

    const response = await callGet('account-1', 'overview')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { accountId: 'account-1' } })
  })

  it('未知の subview は 400 を返す', async () => {
    const response = await callGet('account-1', 'bogus')
    expect(response.status).toBe(400)
  })

  it('Object.prototype 由来のキーを subview として受け付けない', async () => {
    for (const key of ['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty']) {
      const response = await callGet('account-1', key)
      expect(response.status).toBe(400)
    }
  })

  it('存在しないアカウントは 200 + data: null ではなく 404 を返す', async () => {
    getAccountOverview.mockResolvedValue(null)

    const response = await callGet('missing-account', 'overview')

    expect(response.status).toBe(404)
  })

  it('結果が空配列の subview は 404 にしない', async () => {
    getAccountClassification.mockResolvedValue([])

    const response = await callGet('account-1', 'classification')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [] })
  })
})
