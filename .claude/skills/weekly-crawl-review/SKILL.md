---
name: weekly-crawl-review
description: Audits and remediates X/Twitter labeling quality each week using a deterministic review plan and Claude Code subagents. Runs unattended from scripts/weekly-analyze.sh.
---

# Weekly Crawl Review

## Goal

Audit crawler labeling quality every week and detect not only false positives, but also false negatives, rule-behavior mismatches, coverage gaps, and external-threat gaps. Keep sampling and auditability in deterministic code; use Claude Code for evidence interpretation, external research, and remediation.

Treat `references/evaluation-methodology.md` as the source of truth for evaluation methodology, `references/result-contract.md` for structured output, `references/external-research.md` for external research, and `references/remediation.md` for remediation and the PR lifecycle.

## Preconditions

- Confirm the current checkout is a disposable worktree and is not `master`.
- Confirm `WEEKLY_ANALYSIS_RUN_ID`, `WEEKLY_REVIEW_PLAN_FILE`, and `WEEKLY_REVIEW_RESULT_FILE` are set.
- Read `WEEKLY_REVIEW_PLAN_FILE` and verify `seed == WEEKLY_ANALYSIS_RUN_ID` and `strategyVersion == risk-stratified/3`.
- If the plan is missing or invalid, do not fall back to ad hoc sampling. Mark `WeeklyAnalysisRun` failed and stop.
- Investigation queries against the database must be read-only. Database writes are limited to run-state/PR bookkeeping and explicitly authorized remediation.

## Procedure

### 1. Plan triage

Run `scripts/weekly-analysis-heartbeat.sh sampling`. Summarize label risk, sampleKind, and selectionSignals from the plan, then split samples into at most about eight batches. Keep the same label or account in the same batch when practical to reduce duplicate database reads.

### 2. Parallel evidence review

Start the following work concurrently:

Create an agent team for this parallel phase. Spawn each worker as a named agent-team teammate using the matching project subagent definition; do not rely on plain subagents for work that must report through `SendMessage`. Use `judge-0` through `judge-7`, `rule-auditor`, and `researcher` as the initial worker names. A single replacement uses `<original-name>-retry`; do not create retry chains.

- One `weekly-review-sample-judge` per sample batch. Each batch must perform a read-only, blind-first evaluation.
- `weekly-review-rule-auditor` for high-risk labels and recently changed rules.
- `weekly-review-researcher` for current spam and abuse context.

The coordinator integrates sample-judge results. Never drop a sample because a subagent failed: mark execution failures as `skipped` and insufficient evidence as `uncertain`. If the phase exceeds 30 minutes, refresh the `cross_checking` heartbeat.

Use `SendMessage` as the worker liveness and handoff protocol:

- Every worker must send `SendMessage` to recipient `team-lead` before becoming idle, completing, blocking, or failing. A worker that is still active for 5 minutes without completing must send a short progress message.
- `team-lead` must track outstanding workers and their last message. If a worker becomes idle without the required report, immediately send a message that resumes the worker and requests the missing report.
- If an active worker has sent no progress or completion message for 5 minutes, request status with `SendMessage`. If there is still no response after another 5 minutes, send a second request for an immediate partial result or blocking reason.
- If the second request yields no usable response, retry the work once by resuming that worker when possible or starting one replacement. After two failed attempts, stop retrying and record the affected work as `review_incomplete`; planned samples that cannot be judged become `skipped`.

### 3. Aggregate judgments

Create one ledger entry for every planned sample. Keep random audits separate from targeted audits, and never describe a targeted-sample error rate as population precision.

- classifier=true / judge=false -> false-positive candidate; if the final verdict remains `false_positive`, either remediate it in this run with `fixed` or, only when the remaining work qualifies for issue deferral, attach `deferred_to_issue`
- classifier=false / judge=true -> false-negative candidate; if the final verdict remains `false_negative`, either remediate it in this run with `fixed` or, only when the remaining work qualifies for issue deferral, attach `deferred_to_issue`
- judge lacks sufficient evidence -> continue investigating; use `uncertain` at completion only when genuine human judgment is required and the judgment has a `deferred_to_issue` resolution
- execution failure prevents review -> skipped + `review_incomplete`

Do not blindly change a rule from one isolated example. Continue investigating until the suspected defect is supported well enough to remediate, disproved, or clearly requires human judgment / oversized follow-up. Every emitted finding must end as `fixed`, `verified_not_issue`, or `deferred_to_issue`. `deferred_to_issue` is allowed only for `human_judgment_required` or `oversized_scope`; ordinary remediation must stay in the current PR.

### 4. Rule audit and external coverage

Treat specification drift from the rule auditor as a `rule_behavior_mismatch` candidate and resolve it in the same run. Keep external research separate from local evidence; external reports alone are not enough to change a rule, so gather local evidence until the gap is either reproducible and fixed or verified not to apply locally.

Use existing `LabelMetricSnapshot`, `AccountLabelChange`, and plan risk to evaluate topic and behavior coverage. Do not make expensive full-table `LIKE` scans a mandatory step on every run. If a database timeout prevents a core phase, do not hide it behind a successful result; emit `review_incomplete`.

Preserve the intended semantics of `topic_nsfw`, `topic_politics`, and adjacent categories. When evidence supports a rule correction or coverage expansion, remediate it with the same TDD and impact checks as other labels. If the decision genuinely requires human product/policy judgment, create or reuse the matching open GitHub Issue and record `deferred_to_issue` with reason `human_judgment_required`; do not ask the user during this unattended run.

### 5. Remediation

Run `scripts/weekly-analysis-heartbeat.sh implementing`. When remediation is required, follow `references/remediation.md` and make changes with TDD. Bump the rule version whenever rule logic changes.

After remediation, run impact evaluation for each changed label and re-review the changed cohort. If a candidate change has an unexpected blast radius, broad unrelated cohort flips, or unverifiable impact, revert that candidate and continue investigating a narrower safe fix. If the necessary fix becomes too large/risky for the weekly-review PR, classify it as `oversized_scope`, create or reuse the matching open GitHub Issue, and record `deferred_to_issue` instead of forcing the large change into the PR.

### 6. Verify privacy and tests

Confirm that changed files contain no copied or near-verbatim real-world data. Bio and post fixtures must be completely synthetic.

Run `scripts/weekly-analysis-heartbeat.sh verifying`, then run check and format commands for every changed package. If a failure appears environment-specific or pre-existing, verify that the same failure occurs before and after the change and record it in the findings.

### 7. Structured result v3

Run `scripts/weekly-analysis-heartbeat.sh recording`. Following `references/result-contract.md`, always write schemaVersion 3 JSON to `$WEEKLY_REVIEW_RESULT_FILE`. This is the durable diagnostics artifact retained by the supervisor and used for recovery after PR merge. Include exactly one judgment for every planned sample.

Write human-readable `findings` in Japanese. Structured findings must use enabled policy types only. Every finding must include a terminal disposition: `fixed`, `verified_not_issue`, or `deferred_to_issue`, with a concise summary and evidence reference. Before recording `deferred_to_issue`, search existing open Issues and create the GitHub Issue when no exact match exists. The resolution must include `deferReason`, `issueNumber`, and `issueUrl`. Do not include identifying information for real accounts other than Account ID.
For deferral, use `gh issue list --state open` to check for an exact existing tracker. If none exists, create the GitHub Issue with `gh issue create` using a concise title and a body that includes the finding type/scope, abstract evidence references, `deferReason`, and acceptance criteria. Capture the returned Issue URL and number and write them into the resolution before `complete`.

### 8. Complete or open PR

Even when there are no code changes, always pass structured output v3 to `complete --structured-output-file`. Do not pass `sampledAccountIds` manually; the CLI derives them from the persisted review plan.

When code changes exist, follow the PR lifecycle in `references/remediation.md`. Advance the state machine until the PR is merged or otherwise reaches the expected ready state. Call `complete` only when every finding and actionable judgment is either resolved in-run or backed by a created/reused GitHub Issue via `deferred_to_issue`; `skipped` judgments and incomplete phases still block completion. Then make exactly one terminal transition: `complete`, `fail`, or `timeout`.

## Failure policy

- Never complete a run as "no changes" when the plan is inconsistent, the ledger is incomplete, or a core review phase did not run.
- Do not bypass permission or security blocks through alternative mechanisms.
- The main coordinator may retry a failed subagent, but do not retry indefinitely. After a phase fails twice, record `review_incomplete` and fail the run instead of completing.
- Do not treat tmux or Claude process exit as the success condition. The database terminal status is the source of truth.
