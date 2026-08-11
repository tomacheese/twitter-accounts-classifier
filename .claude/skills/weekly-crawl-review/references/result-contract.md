# Structured result contract v2

`WeeklyAnalysisRun.reviewPlan` and `WEEKLY_REVIEW_PLAN_FILE` are the sources of truth for planned samples. Structured output must use schemaVersion 2 and must neither omit nor add samples relative to the plan.

Each item in `review.judgments` must contain:

- sampleId
- accountId
- labelDefinitionId
- labelKey
- sampleKind
- classifierValue
- classifierConfidence
- ruleVersion
- verdict: `correct` / `false_positive` / `false_negative` / `uncertain` / `skipped`
- judgeConfidence
- evidenceReference
- reviewedBy
- unavailableReason: when needed

`review` must contain strategyVersion, seed, budget, plannedSampleCount, reviewedSampleCount, randomAuditCount, targetedAuditCount, uncertainCount, skippedCount, incompletePhases, and judgments. Aggregate counts must equal values mechanically recomputed from judgments.

Use finding types as follows:

- `possible_false_positive`: a reproducible pattern where classifier=true but judge=false
- `possible_false_negative`: a reproducible pattern where classifier=false but judge=true
- `rule_behavior_mismatch`: semantics differ across description, implementation, and tests
- `review_incomplete`: a database timeout, subagent failure, permission denial, or similar failure prevents completion of a core review phase
- `coverage_gap`: an uncovered topic or behavior that repeatedly appears in the local population
- `external_threat_gap`: reproducible external behavior that is observable through local features but not covered by existing rules

`sampleReference` must contain Account ID only; never include handles or content text.
