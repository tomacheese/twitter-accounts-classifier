import { z } from 'zod'

export const severitySchema = z.enum(['critical', 'high', 'medium', 'low'])

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
  maxWeeklyReviewSeverityWithoutCorroboration: severitySchema.optional(),
})

export const detectionPolicySchema = z.object({
  schemaVersion: z.number().int().min(1),
  policyVersion: z.string().min(1),
  rules: z.array(detectionPolicyRuleSchema).min(1),
})

export type DetectionPolicyRule = z.infer<typeof detectionPolicyRuleSchema>
export type DetectionPolicy = z.infer<typeof detectionPolicySchema>
