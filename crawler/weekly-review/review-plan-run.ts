const REVIEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export function buildReviewTargetWindow(startedAt: Date): { targetFrom: Date; targetTo: Date } {
  return {
    targetFrom: new Date(startedAt.getTime() - REVIEW_WINDOW_MS),
    targetTo: startedAt,
  }
}

export function resolvePositiveInteger(
  value: string | undefined,
  defaultValue: number,
  name: string,
): number {
  if (value === undefined) return defaultValue
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}
