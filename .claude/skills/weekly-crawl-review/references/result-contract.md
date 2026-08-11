# Structured result contract v2

`WeeklyAnalysisRun.reviewPlan` と `WEEKLY_REVIEW_PLAN_FILE` が planned sample の正本である。structured output は schemaVersion 2 を使用し、plan の sample を 1 件も欠落・追加させない。

`review.judgments` の各要素は以下を持つ。

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
- unavailableReason: 必要な場合

`review` は strategyVersion、seed、budget、plannedSampleCount、reviewedSampleCount、randomAuditCount、targetedAuditCount、uncertainCount、skippedCount、incompletePhases、judgments を持つ。集計値は judgments から機械的に再計算した値と一致させる。

finding type は以下を使い分ける。

- `possible_false_positive`: classifier=true だが judge=false の再現パターン
- `possible_false_negative`: classifier=false だが judge=true の再現パターン
- `rule_behavior_mismatch`: description・実装・テストの意味が一致しない
- `review_incomplete`: DB timeout、subagent failure、権限拒否などで core review を完遂できない
- `coverage_gap`: ローカル母集団に繰り返し存在する未カバー topic/behavior
- `external_threat_gap`: 外部で再現性があり、ローカル feature で観測可能だが既存 rule が未対応

`sampleReference` は Account ID のみを使い、handle や本文を含めない。
