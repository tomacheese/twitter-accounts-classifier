import { describe, expect, it } from "vitest";
import {
  deriveOverallHealth,
  deriveProcessingLag,
  deriveSourceHealth,
  extractPipelineHealthThresholds,
  parseIsoDurationMs,
} from "./index";

describe("parseIsoDurationMs", () => {
  it("converts the policy durations used by pipeline health", () => {
    expect(parseIsoDurationMs("PT15M")).toBe(900_000);
    expect(parseIsoDurationMs("PT3H")).toBe(10_800_000);
    expect(parseIsoDurationMs("P1D")).toBe(86_400_000);
  });
});

describe("deriveSourceHealth", () => {
  it("allows crawl duration grace before marking the source delayed", () => {
    const sourceWatermarkAt = new Date("2026-08-13T00:00:00Z");

    expect(
      deriveSourceHealth({
        sourceWatermarkAt,
        sourceOutcome: "success",
        expectedIntervalMs: 3 * 60 * 60 * 1000,
        completionGraceMs: 3 * 60 * 60 * 1000,
        staleAfterMs: 12 * 60 * 60 * 1000,
        now: new Date("2026-08-13T05:59:59Z"),
      }).status,
    ).toBe("healthy");

    expect(
      deriveSourceHealth({
        sourceWatermarkAt,
        sourceOutcome: "success",
        expectedIntervalMs: 3 * 60 * 60 * 1000,
        completionGraceMs: 3 * 60 * 60 * 1000,
        staleAfterMs: 12 * 60 * 60 * 1000,
        now: new Date("2026-08-13T06:00:00Z"),
      }).status,
    ).toBe("delayed");
  });
});

describe("deriveProcessingLag", () => {
  it("marks arrived but unprocessed evidence delayed without degrading the source", () => {
    const result = deriveProcessingLag({
      upstreamWatermarkAt: new Date("2026-08-13T03:00:00Z"),
      processedWatermarkAt: new Date("2026-08-13T00:00:00Z"),
      pendingSinceAt: new Date("2026-08-13T03:00:00Z"),
      delayedAfterMs: 15 * 60 * 1000,
      staleAfterMs: 60 * 60 * 1000,
      now: new Date("2026-08-13T03:16:00Z"),
    });

    expect(result).toMatchObject({ status: "delayed", lagMs: 960_000 });
  });
});

describe("deriveOverallHealth", () => {
  it("uses an upstream execution failure as the primary cause over a downstream stale state", () => {
    expect(
      deriveOverallHealth([
        { component: "source", status: "failed" },
        { component: "detector", status: "stale" },
        { component: "projection", status: "stale" },
      ]),
    ).toEqual({ overallStatus: "failed", primaryCause: "source" });
  });
});

describe("extractPipelineHealthThresholds", () => {
  it("uses the operational SLO policy independently from classification rules", () => {
    expect(
      extractPipelineHealthThresholds({
        pipelineHealth: {
          source: {
            expectedInterval: "PT2H",
            completionGrace: "PT30M",
            staleAfter: "PT8H",
          },
          detector: { delayedAfter: "PT10M", staleAfter: "PT40M" },
          projection: { delayedAfter: "PT20M", staleAfter: "PT2H" },
        },
        rules: [{ type: "read_model_freshness", delayedAfter: "P99D" }],
      }),
    ).toEqual({
      source: {
        expectedIntervalMs: 7_200_000,
        completionGraceMs: 1_800_000,
        staleAfterMs: 28_800_000,
      },
      detector: { delayedAfterMs: 600_000, staleAfterMs: 2_400_000 },
      projection: { delayedAfterMs: 1_200_000, staleAfterMs: 7_200_000 },
    });
  });
});
