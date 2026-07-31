import type { AccountLabel, LabelDefinition, PrismaClient } from '../generated/prisma'
import type { LabelRule, LabelRuleResult } from '../labels/types'

export interface LabelDefinitionInput {
  key: string
  description: string
}

export async function ensureLabelDefinition(
  prisma: PrismaClient,
  input: LabelDefinitionInput,
): Promise<LabelDefinition> {
  return prisma.labelDefinition.upsert({
    where: { key: input.key },
    create: input,
    update: { description: input.description },
  })
}

/**
 * Ensures a `LabelDefinition` exists for every given rule.
 * @param prisma - the Prisma client
 * @param rules - the rules to ensure `LabelDefinition`s for
 * @returns a map from each rule's key to its `LabelDefinition` id
 */
export async function ensureLabelDefinitionsForRules(
  prisma: PrismaClient,
  rules: LabelRule[],
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    rules.map(async (rule) => {
      const definition = await ensureLabelDefinition(prisma, {
        key: rule.key,
        description: rule.description,
      })
      return [rule.key, definition.id] as const
    }),
  )
  return new Map(entries)
}

export interface RecordAccountLabelParams {
  accountId: string
  labelDefinitionId: string
  result: LabelRuleResult
  method: string
  ruleVersion: string
}

export async function recordAccountLabel(
  prisma: PrismaClient,
  params: RecordAccountLabelParams,
): Promise<AccountLabel> {
  return prisma.accountLabel.create({
    data: {
      accountId: params.accountId,
      labelDefinitionId: params.labelDefinitionId,
      value: params.result.value,
      confidence: params.result.confidence,
      reason: params.result.reason,
      method: params.method,
      ruleVersion: params.ruleVersion,
    },
  })
}
