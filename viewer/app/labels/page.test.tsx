import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  getPrismaClient: vi.fn(() => ({})),
}))

vi.mock('@/lib/queries/label-summary', () => ({
  listLabelSummaries: vi.fn(),
}))

const { listLabelSummaries } = await import('@/lib/queries/label-summary')
const { default: LabelsPage } = await import('./page')

describe('LabelsPage', () => {
  it('shows true count/evaluated count/coverage/prevalence columns', async () => {
    vi.mocked(listLabelSummaries).mockResolvedValue({
      readiness: 'ready',
      items: [
        {
          labelDefinitionId: 'label-1',
          labelKey: 'spam',
          labelDescription: 'Likely spam account',
          evaluatedCount: 80,
          trueCount: 8,
          populationCount: 100,
          coverage: 0.8,
          prevalence: 0.1,
          qualityStatus: 'normal',
          activeFindingCount: 0,
          highestFindingSeverity: null,
        },
      ],
    })

    const html = renderToStaticMarkup(await LabelsPage())

    expect(html).toContain('True count')
    expect(html).toContain('Evaluated count')
    expect(html).toContain('Coverage')
    expect(html).toContain('>8<')
    expect(html).toContain('>80<')
    expect(html).toContain('80.0%')
    expect(html).toContain('10.0%')
    expect(html).not.toContain('low coverage')
  })

  it('shows a low coverage badge when qualityStatus is unknown', async () => {
    vi.mocked(listLabelSummaries).mockResolvedValue({
      readiness: 'ready',
      items: [
        {
          labelDefinitionId: 'label-1',
          labelKey: 'spam',
          labelDescription: 'Likely spam account',
          evaluatedCount: 0,
          trueCount: 0,
          populationCount: 0,
          coverage: 0,
          prevalence: 0,
          qualityStatus: 'unknown',
          activeFindingCount: 0,
          highestFindingSeverity: null,
        },
      ],
    })

    const html = renderToStaticMarkup(await LabelsPage())

    expect(html).toContain('low coverage')
  })

  it('shows a readiness panel while the read model is bootstrapping', async () => {
    vi.mocked(listLabelSummaries).mockResolvedValue({ readiness: 'bootstrapping', items: [] })

    const html = renderToStaticMarkup(await LabelsPage())

    expect(html).not.toContain('True count')
  })
})
