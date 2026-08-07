import { z } from 'zod'
import { severitySchema } from '../policy/schema'

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
})

export const structuredOutputSchema = z.object({
  schemaVersion: z.number().int().min(1),
  promptVersion: z.string().min(1),
  specVersion: z.string().min(1),
  modelIdentity: z.string().min(1),
  toolIdentity: z.string().min(1),
  repositoryCommit: z.string().min(1),
  targetFrom: z.coerce.date(),
  targetTo: z.coerce.date(),
  sourceRunId: z.string().min(1),
  findings: z.array(weeklyReviewFindingCandidateSchema),
})

export type WeeklyReviewFindingCandidate = z.infer<typeof weeklyReviewFindingCandidateSchema>
export type StructuredOutput = z.infer<typeof structuredOutputSchema>
