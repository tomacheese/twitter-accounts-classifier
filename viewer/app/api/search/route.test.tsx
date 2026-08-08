import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { searchAcrossEntities } = vi.hoisted(() => ({
  searchAcrossEntities: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ getPrismaClient: () => ({}) }))
vi.mock('@/lib/queries/global-search', () => ({ searchAcrossEntities }))

const { GET } = await import('./route')

const originalEnv = process.env.VIEWER_NEW_UI_SECTIONS

beforeEach(() => {
  vi.clearAllMocks()
  searchAcrossEntities.mockResolvedValue({
    accounts: [],
    labels: [],
    findings: [],
    operations: [],
  })
})

afterEach(() => {
  process.env.VIEWER_NEW_UI_SECTIONS = originalEnv
})

describe('GET /api/search', () => {
  it('無効な区画の entity type は searchAcrossEntities へ false を渡す', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'accounts,labels'

    await GET(new Request('http://localhost/api/search?q=example'))

    expect(searchAcrossEntities).toHaveBeenCalledWith(expect.anything(), {
      query: 'example',
      enabledEntityTypes: {
        accounts: true,
        labels: true,
        findings: false,
        operations: false,
      },
    })
  })

  it('新 UI を一切有効にしていなければ全 entity type を無効として渡す', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = ''

    await GET(new Request('http://localhost/api/search?q=example'))

    expect(searchAcrossEntities).toHaveBeenCalledWith(expect.anything(), {
      query: 'example',
      enabledEntityTypes: {
        accounts: false,
        labels: false,
        findings: false,
        operations: false,
      },
    })
  })
})
