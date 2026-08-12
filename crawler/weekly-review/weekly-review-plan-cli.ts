import { parseArgs } from 'node:util'
import type { GenerateWeeklyReviewPlanInput } from './generate-review-plan'
import type { WeeklyReviewPlan } from './review-plan'
import { resolvePositiveInteger } from './review-plan-run'

export interface WeeklyReviewPlanCliDependencies {
  generatePlan(input: GenerateWeeklyReviewPlanInput): Promise<WeeklyReviewPlan>
  writeFile(path: string, content: string): Promise<unknown>
  print(value: string): void
}

export async function runWeeklyReviewPlanCli(
  args: string[],
  dependencies: WeeklyReviewPlanCliDependencies,
): Promise<void> {
  const [command, ...rest] = args
  if (command !== 'build') throw new Error(`Unknown command: ${command}`)

  const { values } = parseArgs({
    args: rest,
    options: {
      id: { type: 'string' },
      output: { type: 'string' },
      budget: { type: 'string' },
      'candidate-pool-size': { type: 'string' },
    },
  })
  if (!values.id || !values.output) throw new Error('--id and --output are required')

  const plan = await dependencies.generatePlan({
    runId: values.id,
    budget: resolvePositiveInteger(values.budget, 240, 'budget'),
    candidatePoolSize: resolvePositiveInteger(
      values['candidate-pool-size'],
      80,
      'candidate-pool-size',
    ),
  })
  await dependencies.writeFile(values.output, `${JSON.stringify(plan, null, 2)}\n`)
  dependencies.print(
    JSON.stringify({
      output: values.output,
      strategyVersion: plan.strategyVersion,
      sampleCount: plan.samples.length,
      budget: plan.budget,
    }),
  )
}
