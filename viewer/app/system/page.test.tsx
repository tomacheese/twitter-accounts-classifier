import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({ getPrismaClient: () => ({}) }))
vi.mock('@/lib/queries/system-console', () => ({ getSystemConsoleData: vi.fn() }))
vi.mock('@/lib/queries/relabel-status', () => ({ getRelabelStatus: vi.fn() }))

const { getSystemConsoleData } = await import('@/lib/queries/system-console')
const { getRelabelStatus } = await import('@/lib/queries/relabel-status')
const { default: SystemPage } = await import('./page')

describe('SystemPage', () => {
  it('4 component の build identity をテーブルで表示する', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'system'
    vi.mocked(getSystemConsoleData).mockResolvedValue({
      identity: { applicationVersion: '1.0.0', environment: 'production' },
      componentHealth: null,
      activePolicy: null,
      readModels: [],
      diagnosticsEnvVars: [],
      pipelineHealth: {
        overallStatus: 'healthy',
        primaryCause: null,
        source: { status: 'healthy', lastSourceWatermarkAt: null, lastOutcome: 'success' },
        detector: {
          status: 'healthy',
          processedWatermarkAt: null,
          lastFailureAt: null,
          errorSummary: null,
        },
        projection: { status: 'healthy', processedWatermarkAt: null },
      },
      componentBuildIdentities: [
        {
          component: 'viewer',
          applicationVersion: '1.0.0',
          gitRevision: 'abc123',
          buildTime: new Date('2026-08-01T00:00:00.000Z'),
          updatedAt: new Date('2026-08-01T00:05:00.000Z'),
        },
        {
          component: 'crawler',
          applicationVersion: 'unknown',
          gitRevision: 'unknown',
          buildTime: null,
          updatedAt: new Date('2026-08-01T00:06:00.000Z'),
        },
      ],
    })
    vi.mocked(getRelabelStatus).mockResolvedValue({
      labelCoverage: [],
      backlog: [],
      scanCursorUpdatedAt: null,
    })

    const html = renderToStaticMarkup(await SystemPage())

    expect(html).toContain('Component build identity')
    expect(html).toContain('viewer')
    expect(html).toContain('abc123')
    expect(html).toContain('crawler')
    expect(html).toContain('unknown')
  })

  it('getRelabelStatus が失敗しても他セクションは表示され続ける', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'system'
    vi.mocked(getSystemConsoleData).mockResolvedValue({
      identity: { applicationVersion: '1.0.0', environment: 'production' },
      componentHealth: null,
      activePolicy: null,
      readModels: [],
      diagnosticsEnvVars: [],
      pipelineHealth: {
        overallStatus: 'healthy',
        primaryCause: null,
        source: { status: 'healthy', lastSourceWatermarkAt: null, lastOutcome: 'success' },
        detector: {
          status: 'healthy',
          processedWatermarkAt: null,
          lastFailureAt: null,
          errorSummary: null,
        },
        projection: { status: 'healthy', processedWatermarkAt: null },
      },
      componentBuildIdentities: [],
    })
    vi.mocked(getRelabelStatus).mockRejectedValue(new Error('db error'))

    const html = renderToStaticMarkup(await SystemPage())

    expect(html).toContain('System identity')
    expect(html).toContain('Failed to load the relabel status data.')
  })
})
