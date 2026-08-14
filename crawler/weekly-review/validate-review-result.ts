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
    incompletePhases: string[]
    judgments: { sampleId: string; verdict: string; resolution?: { status?: string } }[]
  }
  findings: { resolution?: { status?: string } }[]
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
  if (!Array.isArray(value.findings)) throw new Error('invalid structured findings')
  const findings = value.findings.map((finding) => {
    if (!isRecord(finding)) throw new Error('invalid structured finding')
    const resolution = isRecord(finding.resolution)
      ? {
          status:
            typeof finding.resolution.status === 'string' ? finding.resolution.status : undefined,
        }
      : undefined
    return { resolution }
  })
  if (!isRecord(value.review)) return { schemaVersion: value.schemaVersion, findings }
  if (
    typeof value.review.strategyVersion !== 'string' ||
    typeof value.review.seed !== 'string' ||
    !Array.isArray(value.review.incompletePhases) ||
    !value.review.incompletePhases.every((phase) => typeof phase === 'string') ||
    !Array.isArray(value.review.judgments)
  ) {
    throw new TypeError('invalid structured review output')
  }
  const judgments = value.review.judgments.map((judgment) => {
    if (
      !isRecord(judgment) ||
      typeof judgment.sampleId !== 'string' ||
      typeof judgment.verdict !== 'string'
    ) {
      throw new Error('invalid structured review judgment')
    }
    const resolution = isRecord(judgment.resolution)
      ? {
          status:
            typeof judgment.resolution.status === 'string' ? judgment.resolution.status : undefined,
        }
      : undefined
    return { sampleId: judgment.sampleId, verdict: judgment.verdict, resolution }
  })
  return {
    schemaVersion: value.schemaVersion,
    review: {
      strategyVersion: value.review.strategyVersion,
      seed: value.review.seed,
      incompletePhases: value.review.incompletePhases,
      judgments,
    },
    findings,
  }
}

export function validateReviewResultAgainstPlan(
  reviewPlan: unknown,
  structuredOutput: unknown,
): void {
  const plan = parsePlan(reviewPlan)
  const result = parseResult(structuredOutput)
  if (result.schemaVersion < 3 || !result.review) {
    throw new Error('structured output schemaVersion 3 is required when a review plan exists')
  }
  if (result.review.strategyVersion !== plan.strategyVersion || result.review.seed !== plan.seed) {
    throw new Error('review result does not match review plan identity')
  }
  if (result.review.incompletePhases.length > 0) {
    throw new Error('review result contains incomplete phases')
  }
  if (
    result.review.judgments.some((judgment) => {
      if (judgment.verdict === 'skipped') return true
      if (judgment.verdict === 'uncertain') {
        return judgment.resolution?.status !== 'deferred_to_issue'
      }
      if (judgment.verdict === 'false_positive' || judgment.verdict === 'false_negative') {
        return (
          judgment.resolution?.status !== 'fixed' &&
          judgment.resolution?.status !== 'deferred_to_issue'
        )
      }
      return false
    })
  ) {
    throw new Error('review result contains unresolved sample judgments')
  }
  if (
    result.findings.some(
      (finding) =>
        finding.resolution?.status !== 'fixed' &&
        finding.resolution?.status !== 'verified_not_issue' &&
        finding.resolution?.status !== 'deferred_to_issue',
    )
  ) {
    throw new Error('review result contains unresolved findings')
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
