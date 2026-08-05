import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

vi.mock('@/lib/prisma', () => ({
  getPrismaClient: vi.fn(() => ({})),
}))

vi.mock('@/lib/queries/system-status', () => ({
  getSystemStatus: vi.fn(),
}))

const { getSystemStatus } = await import('@/lib/queries/system-status')
const { SystemStatusSectionData } = await import('./page')

describe('SystemStatusSectionData', () => {
  beforeEach(() => {
    vi.mocked(getSystemStatus).mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('renders a section-scoped retry button instead of the whole-route fallback when the query fails', async () => {
    vi.mocked(getSystemStatus).mockRejectedValue(new Error('Example query failure.'))

    const element = await SystemStatusSectionData()
    const html = renderToStaticMarkup(element)

    expect(html).toContain('Failed to load the system status.')
    expect(html).toContain('Retry')
    expect(html).toContain('system-status-heading')
  })
})
