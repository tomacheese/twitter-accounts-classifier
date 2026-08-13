import { z } from 'zod'

/** severity 値の許容集合。 */
export const severitySchema = z.enum(['critical', 'high', 'medium', 'low'])

/** 検出ルール 1 件のスキーマ。 */
export const detectionPolicyRuleSchema = z.object({
  type: z.string().min(1),
  enabled: z.boolean(),
  detectorType: z.enum(['invariant', 'comparative', 'weekly_review']),
  identityVersion: z.number().int().min(1),
  severity: severitySchema,
  minimumSampleSize: z.number().int().min(0).optional(),
  absoluteThreshold: z.number().optional(),
  relativeThreshold: z.number().optional(),
  baselineWindow: z.string().optional(),
  activationCount: z.number().int().min(1).default(1),
  resolutionCount: z.number().int().min(1).default(1),
  activationThreshold: z.number().optional(),
  resolutionThreshold: z.number().optional(),
  criticalImmediate: z.boolean().default(false),
  recurrenceWindow: z.string().optional(),
  cooldown: z.string().optional(),
  delayedAfter: z.string().optional(),
  staleAfter: z.string().optional(),
  minCoverage: z.number().min(0).max(1).optional(),
  maxStaleRatio: z.number().min(0).max(1).optional(),
  maxWeeklyReviewSeverityWithoutCorroboration: severitySchema.optional(),
})

const pipelineHealthStageSchema = z.object({
  delayedAfter: z.string().min(1),
  staleAfter: z.string().min(1),
})

/** source arrival と downstream lag を区別する運用 SLO。 */
export const pipelineHealthPolicySchema = z.object({
  source: z.object({
    expectedInterval: z.string().min(1),
    completionGrace: z.string().min(1),
    staleAfter: z.string().min(1),
  }),
  detector: pipelineHealthStageSchema,
  projection: pipelineHealthStageSchema,
})

/** detection-policy.json 全体のスキーマ。 */
export const detectionPolicySchema = z.object({
  schemaVersion: z.number().int().min(1),
  policyVersion: z.string().min(1),
  pipelineHealth: pipelineHealthPolicySchema.optional(),
  rules: z.array(detectionPolicyRuleSchema).min(1),
})

/** 検証済みの検出ルール 1 件。 */
export type DetectionPolicyRule = z.infer<typeof detectionPolicyRuleSchema>
/** 検証済みの検出ポリシー全体。 */
export type DetectionPolicy = z.infer<typeof detectionPolicySchema>
