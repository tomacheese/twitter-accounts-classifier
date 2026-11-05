import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getAccountOverview, getAccountClassification, getAccountRelations } = vi.hoisted(() => ({
  getAccountOverview: vi.fn(),
  getAccountClassification: vi.fn(),
  getAccountRelations: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ getPrismaClient: () => ({}) }))
vi.mock('@/lib/queries/account-subviews', () => ({
  getAccountOverview,
  getAccountClassification,
  getAccountEvidence: vi.fn(),
  getAccountRelations,
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
  it('accounts feature flag が無くても既知の subview を利用できる', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = ''
    getAccountOverview.mockResolvedValue({ accountId: '1001' })

    const response = await callGet('1001', 'overview')

    expect(response.status).toBe(200)
  })

  it('既知の subview はデータを 200 で返す', async () => {
    getAccountOverview.mockResolvedValue({ accountId: '1001' })

    const response = await callGet('1001', 'overview')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { accountId: '1001' } })
  })

  it('ID として解釈できない accountId は DB を引かずに 404 を返す', async () => {
    const response = await callGet('not-a-number', 'overview')

    expect(response.status).toBe(404)
    expect(getAccountOverview).not.toHaveBeenCalled()
  })

  it('未知の subview は 400 を返す', async () => {
    const response = await callGet('1001', 'bogus')
    expect(response.status).toBe(400)
  })

  it('Object.prototype 由来のキーを subview として受け付けない', async () => {
    for (const key of ['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty']) {
      const response = await callGet('1001', key)
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

    const response = await callGet('1001', 'classification')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [] })
  })

  it('relations は cursor/limit クエリパラメータを getAccountRelations に伝える', async () => {
    getAccountRelations.mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 })

    const response = await GET(new Request('http://localhost/api?cursor=abc&limit=10'), {
      params: Promise.resolve({ accountId: '1001', subview: 'relations' }),
    })

    expect(response.status).toBe(200)
    expect(getAccountRelations).toHaveBeenCalledWith(expect.anything(), '1001', {
      cursor: 'abc',
      limit: 10,
    })
  })

  it('relations はクエリパラメータが無ければ cursor/limit を undefined で渡す', async () => {
    getAccountRelations.mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 })

    await GET(new Request('http://localhost/api'), {
      params: Promise.resolve({ accountId: '1001', subview: 'relations' }),
    })

    expect(getAccountRelations).toHaveBeenCalledWith(expect.anything(), '1001', {
      cursor: undefined,
      limit: undefined,
    })
  })

  it('relations の limit が数値でなければ undefined として渡す', async () => {
    getAccountRelations.mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 })

    await GET(new Request('http://localhost/api?limit=abc'), {
      params: Promise.resolve({ accountId: '1001', subview: 'relations' }),
    })

    expect(getAccountRelations).toHaveBeenCalledWith(
      expect.anything(),
      '1001',
      expect.objectContaining({ limit: undefined }),
    )
  })

  it('relations の limit が 0 以下なら undefined として渡す', async () => {
    getAccountRelations.mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 })

    await GET(new Request('http://localhost/api?limit=-5'), {
      params: Promise.resolve({ accountId: '1001', subview: 'relations' }),
    })

    expect(getAccountRelations).toHaveBeenCalledWith(
      expect.anything(),
      '1001',
      expect.objectContaining({ limit: undefined }),
    )
  })
})
