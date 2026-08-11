interface ReviewPlanLike {
  strategyVersion: string
  seed: string
  samples: { sampleId: string }[]
}

interface ReviewResultLike {
  schemaVersion: number
  review?: {
    strategyVersion: string
    seed: string
    judgments: { sampleId: string }[]
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parsePlan(value: unknown): ReviewPlanLike {
  if (
    !isRecord(value) ||
    typeof value.strategyVersion !== 'string' ||
    typeof value.seed !== 'string'
  ) {
    throw new Error('invalid review plan')
  }
  if (!Array.isArray(value.samples)) throw new Error('invalid review plan samples')
  const samples = value.samples.map((sample) => {
    if (!isRecord(sample) || typeof sample.sampleId !== 'string') {
      throw new Error('invalid review plan sample')
    }
    return { sampleId: sample.sampleId }
  })
  return { strategyVersion: value.strategyVersion, seed: value.seed, samples }
}

function parseResult(value: unknown): ReviewResultLike {
  if (!isRecord(value) || typeof value.schemaVersion !== 'number') {
    throw new Error('invalid structured output')
  }
  if (!isRecord(value.review)) return { schemaVersion: value.schemaVersion }
  if (
    typeof value.review.strategyVersion !== 'string' ||
    typeof value.review.seed !== 'string' ||
    !Array.isArray(value.review.judgments)
  ) {
    throw new TypeError('invalid structured review output')
  }
  const judgments = value.review.judgments.map((judgment) => {
    if (!isRecord(judgment) || typeof judgment.sampleId !== 'string') {
      throw new Error('invalid structured review judgment')
    }
    return { sampleId: judgment.sampleId }
  })
  return {
    schemaVersion: value.schemaVersion,
    review: {
      strategyVersion: value.review.strategyVersion,
      seed: value.review.seed,
      judgments,
    },
  }
}

export function validateReviewResultAgainstPlan(
  reviewPlan: unknown,
  structuredOutput: unknown,
): void {
  const plan = parsePlan(reviewPlan)
  const result = parseResult(structuredOutput)
  if (result.schemaVersion < 2 || !result.review) {
    throw new Error('structured output schemaVersion 2 is required when a review plan exists')
  }
  if (result.review.strategyVersion !== plan.strategyVersion || result.review.seed !== plan.seed) {
    throw new Error('review result does not match review plan identity')
  }

  const plannedIds = plan.samples.map((sample) => sample.sampleId).toSorted()
  const judgedIds = result.review.judgments.map((judgment) => judgment.sampleId).toSorted()
  if (
    plannedIds.length !== judgedIds.length ||
    plannedIds.some((sampleId, index) => sampleId !== judgedIds[index])
  ) {
    throw new Error('review judgments do not exactly cover review plan samples')
  }
}

export function extractPlannedAccountIds(reviewPlan: unknown): string[] {
  if (!isRecord(reviewPlan) || !Array.isArray(reviewPlan.samples)) {
    throw new Error('invalid review plan samples')
  }
  const accountIds: string[] = []
  const seen = new Set<string>()
  for (const sample of reviewPlan.samples) {
    if (!isRecord(sample) || typeof sample.accountId !== 'string') {
      throw new Error('invalid review plan sample accountId')
    }
    if (seen.has(sample.accountId)) continue
    seen.add(sample.accountId)
    accountIds.push(sample.accountId)
  }
  return accountIds
}
