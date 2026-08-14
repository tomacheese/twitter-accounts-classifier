import { z } from 'zod'
import { severitySchema } from '../policy/schema'

const resolutionBaseSchema = {
  summary: z.string().min(1),
  evidenceReference: z.string().min(1),
}
const deferredResolutionSchema = z.object({
  status: z.literal('deferred_to_issue'),
  ...resolutionBaseSchema,
  deferReason: z.enum(['human_judgment_required', 'oversized_scope']),
  issueNumber: z.number().int().positive(),
  issueUrl: z
    .string()
    .url()
    .regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/),
})

export const weeklyReviewResolutionSchema = z
  .discriminatedUnion('status', [
    z.object({ status: z.literal('fixed'), ...resolutionBaseSchema }),
    z.object({ status: z.literal('verified_not_issue'), ...resolutionBaseSchema }),
    deferredResolutionSchema,
  ])
  .superRefine((resolution, ctx) => {
    if (resolution.status !== 'deferred_to_issue') return
    const issueNumber = Number(resolution.issueUrl.split('/').at(-1))
    if (issueNumber !== resolution.issueNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['issueUrl'],
        message: 'issueUrl must match issueNumber',
      })
    }
  })

export const weeklyReviewSampleKindSchema = z.enum([
  'random_positive',
  'random_negative',
  'recent_change',
  'high_confidence_negative',
  'positive_evidence_negative',
  'low_confidence_positive',
  'old_rule_version',
  'rare_reason',
  'risk_targeted',
  'insufficient_support',
])

export const weeklyReviewVerdictSchema = z.enum([
  'correct',
  'false_positive',
  'false_negative',
  'uncertain',
  'skipped',
])

export const weeklyReviewSampleJudgmentSchema = z.object({
  sampleId: z.string().min(1),
  accountId: z.string().min(1),
  labelDefinitionId: z.string().min(1),
  labelKey: z.string().min(1),
  sampleKind: weeklyReviewSampleKindSchema,
  classifierValue: z.boolean(),
  classifierConfidence: z.number().min(0).max(1),
  ruleVersion: z.string().min(1),
  verdict: weeklyReviewVerdictSchema,
  judgeConfidence: z.number().min(0).max(1),
  evidenceReference: z.string().min(1),
  reviewedBy: z.string().min(1),
  unavailableReason: z.string().min(1).optional(),
  populationCount: z.number().int().min(0).optional(),
  classifierEvaluable: z.boolean().optional(),
  resolution: weeklyReviewResolutionSchema.optional(),
})

export const weeklyReviewSummarySchema = z
  .object({
    strategyVersion: z.string().min(1),
    seed: z.string().min(1),
    budget: z.number().int().positive(),
    plannedSampleCount: z.number().int().min(0),
    reviewedSampleCount: z.number().int().min(0),
    randomAuditCount: z.number().int().min(0),
    targetedAuditCount: z.number().int().min(0),
    uncertainCount: z.number().int().min(0),
    skippedCount: z.number().int().min(0),
    incompletePhases: z.array(z.string().min(1)),
    judgments: z.array(weeklyReviewSampleJudgmentSchema),
  })
  .superRefine((review, ctx) => {
    const sampleIds = new Set(review.judgments.map((judgment) => judgment.sampleId))
    if (sampleIds.size !== review.judgments.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'judgment sampleId must be unique' })
    }

    const reviewed = review.judgments.filter((judgment) => judgment.verdict !== 'skipped').length
    const random = review.judgments.filter(
      (judgment) =>
        judgment.sampleKind === 'random_positive' || judgment.sampleKind === 'random_negative',
    ).length
    const uncertain = review.judgments.filter((judgment) => judgment.verdict === 'uncertain').length
    const skipped = review.judgments.filter((judgment) => judgment.verdict === 'skipped').length
    const expected = {
      plannedSampleCount: review.judgments.length,
      reviewedSampleCount: reviewed,
      randomAuditCount: random,
      targetedAuditCount: review.judgments.length - random,
      uncertainCount: uncertain,
      skippedCount: skipped,
    }
    for (const [field, value] of Object.entries(expected)) {
      if (review[field as keyof typeof expected] !== value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} does not match judgments`,
        })
      }
    }
  })

export const weeklyReviewFindingResolutionSchema = weeklyReviewResolutionSchema

export const weeklyReviewFindingCandidateSchema = z.object({
  type: z.string().min(1),
  dimensions: z.record(z.string()),
  primaryScopeType: z.string().min(1),
  primaryScopeId: z.string().min(1),
  confidence: z.number().min(0).max(1),
  sampleCount: z.number().int().min(0),
  sampleReference: z.array(z.string()),
  evidenceReference: z.string().min(1),
  structuredMeasurement: z.record(z.unknown()),
  suggestedSeverity: severitySchema,
  unavailableReason: z.string().optional(),
  resolution: weeklyReviewFindingResolutionSchema.optional(),
})

export const structuredOutputSchema = z
  .object({
    schemaVersion: z.number().int().min(1),
    promptVersion: z.string().min(1),
    specVersion: z.string().min(1),
    modelIdentity: z.string().min(1),
    toolIdentity: z.string().min(1),
    repositoryCommit: z.string().min(1),
    targetFrom: z.coerce.date(),
    targetTo: z.coerce.date(),
    sourceRunId: z.string().min(1),
    review: weeklyReviewSummarySchema.optional(),
    findings: z.array(weeklyReviewFindingCandidateSchema),
  })
  .superRefine((output, ctx) => {
    if (output.schemaVersion >= 2 && !output.review) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['review'],
        message: 'review is required for schemaVersion >= 2',
      })
    }
    if (output.schemaVersion >= 3) {
      for (const [index, judgment] of (output.review?.judgments ?? []).entries()) {
        if (
          (judgment.verdict === 'false_positive' || judgment.verdict === 'false_negative') &&
          judgment.resolution?.status !== 'fixed' &&
          judgment.resolution?.status !== 'deferred_to_issue'
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['review', 'judgments', index, 'resolution'],
            message:
              'misclassification resolution must be fixed or deferred_to_issue for schemaVersion >= 3',
          })
        }
      }
      for (const [index, finding] of output.findings.entries()) {
        if (!finding.resolution) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['findings', index, 'resolution'],
            message: 'finding resolution is required for schemaVersion >= 3',
          })
        }
      }
    }
  })

export type WeeklyReviewResolution = z.infer<typeof weeklyReviewResolutionSchema>
export type WeeklyReviewSampleJudgment = z.infer<typeof weeklyReviewSampleJudgmentSchema>
export type WeeklyReviewSummary = z.infer<typeof weeklyReviewSummarySchema>
export type WeeklyReviewFindingResolution = z.infer<typeof weeklyReviewFindingResolutionSchema>
export type WeeklyReviewFindingCandidate = z.infer<typeof weeklyReviewFindingCandidateSchema>
export type StructuredOutput = z.infer<typeof structuredOutputSchema>
