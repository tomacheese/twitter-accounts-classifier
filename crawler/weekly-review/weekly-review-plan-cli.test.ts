import { describe, expect, it, vi } from 'vitest'
import { runWeeklyReviewPlanCli } from './weekly-review-plan-cli'

const plan = {
  schemaVersion: 1 as const,
  strategyVersion: 'risk-stratified/1' as const,
  seed: 'run-1',
  budget: 240,
  targetFrom: '2026-08-05T00:00:00.000Z',
  targetTo: '2026-08-12T00:00:00.000Z',
  labels: [],
  samples: [],
}

describe('runWeeklyReviewPlanCli', () => {
  it('build は既定 budget 240・candidate pool 80 で plan を JSON 保存する', async () => {
    const generatePlan = vi.fn().mockResolvedValue(plan)
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const print = vi.fn()

    await runWeeklyReviewPlanCli(['build', '--id', 'run-1', '--output', '/tmp/plan.json'], {
      generatePlan,
      writeFile,
      print,
    })

    expect(generatePlan).toHaveBeenCalledWith({
      runId: 'run-1',
      budget: 240,
      candidatePoolSize: 80,
    })
    expect(writeFile).toHaveBeenCalledWith('/tmp/plan.json', `${JSON.stringify(plan, null, 2)}\n`)
    expect(print).toHaveBeenCalledWith(
      JSON.stringify({
        output: '/tmp/plan.json',
        strategyVersion: 'risk-stratified/1',
        sampleCount: 0,
        budget: 240,
      }),
    )
  })

  it('budget と candidate-pool-size を上書きできる', async () => {
    const generatePlan = vi.fn().mockResolvedValue(plan)

    await runWeeklyReviewPlanCli(
      [
        'build',
        '--id',
        'run-1',
        '--output',
        '/tmp/plan.json',
        '--budget',
        '100',
        '--candidate-pool-size',
        '300',
      ],
      { generatePlan, writeFile: vi.fn(), print: vi.fn() },
    )

    expect(generatePlan).toHaveBeenCalledWith({
      runId: 'run-1',
      budget: 100,
      candidatePoolSize: 300,
    })
  })

  it('必須引数が無ければ拒否する', async () => {
    await expect(
      runWeeklyReviewPlanCli(['build', '--id', 'run-1'], {
        generatePlan: vi.fn(),
        writeFile: vi.fn(),
        print: vi.fn(),
      }),
    ).rejects.toThrow('--id and --output are required')
  })
})
