import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const redirectMock = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`)
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  redirect: redirectMock,
}))

vi.mock('@/lib/prisma', () => ({
  getPrismaClient: vi.fn(() => ({})),
}))

vi.mock('@/lib/queries/system-status', () => ({
  getSystemStatus: vi.fn(),
}))

const { getSystemStatus } = await import('@/lib/queries/system-status')
const { default: DashboardPage, SystemStatusSectionData } = await import('./page')

describe('SystemStatusSectionData', () => {
  beforeEach(() => {
    vi.mocked(getSystemStatus).mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
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

describe('DashboardPage', () => {
  const originalFlag = process.env.VIEWER_NEW_UI_SECTIONS

  afterEach(() => {
    process.env.VIEWER_NEW_UI_SECTIONS = originalFlag
    redirectMock.mockClear()
  })

  it('redirects to /overview when the overview section is enabled', () => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'overview'
    expect(() => DashboardPage()).toThrow('NEXT_REDIRECT:/overview')
    expect(redirectMock).toHaveBeenCalledWith('/overview')
  })

  it('does not redirect when the overview section is disabled', () => {
    process.env.VIEWER_NEW_UI_SECTIONS = ''
    expect(() => DashboardPage()).not.toThrow()
    expect(redirectMock).not.toHaveBeenCalled()
  })
})
