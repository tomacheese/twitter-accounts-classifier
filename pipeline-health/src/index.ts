export type PipelineHealthStatus =
  "healthy" | "delayed" | "stale" | "unknown" | "failed";

export interface SourceHealthInput {
  sourceWatermarkAt: Date | null;
  sourceOutcome: "success" | "partial" | "failed" | null;
  expectedIntervalMs: number;
  completionGraceMs: number;
  staleAfterMs: number;
  now: Date;
}

export interface SourceHealth {
  status: PipelineHealthStatus;
  lastSourceWatermarkAt: Date | null;
  expectedNextAt: Date | null;
  delayedAt: Date | null;
  staleAt: Date | null;
  lastSourceOutcome: SourceHealthInput["sourceOutcome"];
}

export interface ProcessingLagInput {
  upstreamWatermarkAt: Date | null;
  processedWatermarkAt: Date | null;
  pendingSinceAt: Date | null;
  delayedAfterMs: number;
  staleAfterMs: number;
  now: Date;
}

export interface ProcessingLag {
  status: PipelineHealthStatus;
  lagMs: number | null;
  upstreamWatermarkAt: Date | null;
  processedWatermarkAt: Date | null;
}

export interface OverallHealthComponent {
  component: string;
  status: PipelineHealthStatus;
}

const STATUS_SEVERITY: Record<PipelineHealthStatus, number> = {
  unknown: 0,
  healthy: 1,
  delayed: 2,
  stale: 3,
  failed: 4,
};

/**
 * pipeline policy に使う ISO 8601 duration の日・時・分を milliseconds へ変換する。
 * @param duration - P1D、PT3H、PT15M の形式の duration
 * @returns milliseconds
 */
export function parseIsoDurationMs(duration: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(duration);
  if (!match || (!match[1] && !match[2] && !match[3])) {
    throw new Error(`unsupported duration format: ${duration}`);
  }
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  return ((days * 24 + hours) * 60 + minutes) * 60 * 1000;
}

/**
 * @param input - last published evidence と source expectation policy
 * @returns source arrival health と次の境界時刻
 */
export function deriveSourceHealth(input: SourceHealthInput): SourceHealth {
  if (!input.sourceWatermarkAt) {
    return {
      status: "unknown",
      lastSourceWatermarkAt: null,
      expectedNextAt: null,
      delayedAt: null,
      staleAt: null,
      lastSourceOutcome: input.sourceOutcome,
    };
  }

  const sourceTime = input.sourceWatermarkAt.getTime();
  const expectedNextAt = new Date(sourceTime + input.expectedIntervalMs);
  const delayedAt = new Date(
    expectedNextAt.getTime() + input.completionGraceMs,
  );
  const staleAt = new Date(sourceTime + input.staleAfterMs);
  const now = input.now.getTime();
  const status =
    now >= staleAt.getTime()
      ? "stale"
      : now >= delayedAt.getTime()
        ? "delayed"
        : "healthy";

  return {
    status,
    lastSourceWatermarkAt: input.sourceWatermarkAt,
    expectedNextAt,
    delayedAt,
    staleAt,
    lastSourceOutcome: input.sourceOutcome,
  };
}

/**
 * @param input - upstream evidence/projection watermark と processor state
 * @returns lag health。upstream を処理済みなら elapsed time に関係なく healthy
 */
export function deriveProcessingLag(input: ProcessingLagInput): ProcessingLag {
  if (!input.upstreamWatermarkAt) {
    return {
      status: "unknown",
      lagMs: null,
      upstreamWatermarkAt: null,
      processedWatermarkAt: input.processedWatermarkAt,
    };
  }

  if (
    input.processedWatermarkAt &&
    input.processedWatermarkAt.getTime() >= input.upstreamWatermarkAt.getTime()
  ) {
    return {
      status: "healthy",
      lagMs: 0,
      upstreamWatermarkAt: input.upstreamWatermarkAt,
      processedWatermarkAt: input.processedWatermarkAt,
    };
  }

  if (!input.pendingSinceAt) {
    return {
      status: "unknown",
      lagMs: null,
      upstreamWatermarkAt: input.upstreamWatermarkAt,
      processedWatermarkAt: input.processedWatermarkAt,
    };
  }

  const lagMs = Math.max(
    0,
    input.now.getTime() - input.pendingSinceAt.getTime(),
  );
  const status =
    lagMs >= input.staleAfterMs
      ? "stale"
      : lagMs >= input.delayedAfterMs
        ? "delayed"
        : "healthy";
  return {
    status,
    lagMs,
    upstreamWatermarkAt: input.upstreamWatermarkAt,
    processedWatermarkAt: input.processedWatermarkAt,
  };
}

/**
 * @param components - upstream から downstream の順に渡す component health
 * @returns worst status と同一 severity では upstream を選ぶ primary cause
 */
export function deriveOverallHealth(components: OverallHealthComponent[]): {
  overallStatus: PipelineHealthStatus;
  primaryCause: string | null;
} {
  let overallStatus: PipelineHealthStatus = "unknown";
  let primaryCause: string | null = null;

  for (const component of components) {
    if (STATUS_SEVERITY[component.status] <= STATUS_SEVERITY[overallStatus])
      continue;
    overallStatus = component.status;
    primaryCause = component.component;
  }

  return { overallStatus, primaryCause };
}
