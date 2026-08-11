import type { StructuredOutput } from './structured-output-schema'

interface ReviewPlanIdentity {
  strategyVersion: string
  seed: string
  sampleIds: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parsePlan(value: unknown): ReviewPlanIdentity {
  if (
    !isRecord(value) ||
    typeof value.strategyVersion !== 'string' ||
    typeof value.seed !== 'string'
  ) {
    throw new Error('invalid weekly review plan')
  }
  if (!Array.isArray(value.samples)) throw new Error('invalid weekly review plan samples')
  const sampleIds = value.samples.map((sample) => {
    if (!isRecord(sample) || typeof sample.sampleId !== 'string') {
      throw new Error('invalid weekly review plan sample')
    }
    return sample.sampleId
  })
  return { strategyVersion: value.strategyVersion, seed: value.seed, sampleIds }
}

export function validateStructuredOutputAgainstReviewPlan(
  reviewPlan: unknown,
  output: StructuredOutput,
): void {
  const plan = parsePlan(reviewPlan)
  if (output.schemaVersion < 2 || !output.review) {
    throw new Error('weekly review plan requires structured output v2')
  }
  if (output.review.strategyVersion !== plan.strategyVersion || output.review.seed !== plan.seed) {
    throw new Error('weekly review plan identity mismatch')
  }

  const planned = plan.sampleIds.toSorted()
  const judged = output.review.judgments.map((judgment) => judgment.sampleId).toSorted()
  if (
    planned.length !== judged.length ||
    planned.some((sampleId, index) => sampleId !== judged[index])
  ) {
    throw new Error('weekly review plan coverage mismatch')
  }
}
