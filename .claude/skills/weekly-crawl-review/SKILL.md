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
- Read `WEEKLY_REVIEW_PLAN_FILE` and verify `seed == WEEKLY_ANALYSIS_RUN_ID` and `strategyVersion == risk-stratified/1`.
- If the plan is missing or invalid, do not fall back to ad hoc sampling. Mark `WeeklyAnalysisRun` failed and stop.
- Investigation queries against the database must be read-only. Database writes are limited to run-state/PR bookkeeping and explicitly authorized remediation.

## Procedure

### 1. Plan triage

Run `scripts/weekly-analysis-heartbeat.sh sampling`. Summarize label risk, sampleKind, and selectionSignals from the plan, then split samples into at most about eight batches. Keep the same label or account in the same batch when practical to reduce duplicate database reads.

### 2. Parallel evidence review

Start the following work concurrently:

- One `weekly-review-sample-judge` per sample batch. Each batch must perform a read-only, blind-first evaluation.
- `weekly-review-rule-auditor` for high-risk labels and recently changed rules.
- `weekly-review-researcher` for current spam and abuse context.

The coordinator integrates sample-judge results. Never drop a sample because a subagent failed: mark execution failures as `skipped` and insufficient evidence as `uncertain`. If the phase exceeds 30 minutes, refresh the `cross_checking` heartbeat.

### 3. Aggregate judgments

Create one ledger entry for every planned sample. Keep random audits separate from targeted audits, and never describe a targeted-sample error rate as population precision.

- classifier=true / judge=false -> false-positive candidate
- classifier=false / judge=true -> false-negative candidate
- judge lacks sufficient evidence -> uncertain
- execution failure prevents review -> skipped + `review_incomplete`

Promote only patterns that generalize to the same rule predicate, reason family, or boundary condition into remediation candidates; do not remediate from isolated examples alone.

### 4. Rule audit and external coverage

Treat specification drift from the rule auditor as a `rule_behavior_mismatch` candidate. Keep external research separate from local evidence and do not auto-fix based on external reports alone.

Use existing `LabelMetricSnapshot`, `AccountLabelChange`, and plan risk to evaluate topic and behavior coverage. Do not make expensive full-table `LIKE` scans a mandatory step on every run. If a database timeout prevents a core phase, do not hide it behind a successful result; emit `review_incomplete`.

Preserve existing carve-outs for `topic_nsfw`, `topic_politics`, and adjacent categories. You may record observations, but do not broaden them or add new subcategories without explicit user sign-off.

### 5. Remediation

Run `scripts/weekly-analysis-heartbeat.sh implementing`. When remediation is required, follow `references/remediation.md` and make changes with TDD. Bump the rule version whenever rule logic changes.

After remediation, run impact evaluation for each changed label and re-review the changed cohort. Revert the change and keep only the finding if there is an unexpected blast radius, broad unrelated cohort flips, or the impact cannot be verified.

### 6. Verify privacy and tests

Confirm that changed files contain no copied or near-verbatim real-world data. Bio and post fixtures must be completely synthetic.

Run `scripts/weekly-analysis-heartbeat.sh verifying`, then run check and format commands for every changed package. If a failure appears environment-specific or pre-existing, verify that the same failure occurs before and after the change and record it in the findings.

### 7. Structured result v2

Run `scripts/weekly-analysis-heartbeat.sh recording`. Following `references/result-contract.md`, always write schemaVersion 2 JSON to `$WEEKLY_REVIEW_RESULT_FILE`. This is the durable diagnostics artifact retained by the supervisor and used for recovery after PR merge. Include exactly one judgment for every planned sample.

Write human-readable `findings` in Japanese. Structured findings must use enabled policy types only. Do not include identifying information for real accounts other than Account ID.

### 8. Complete or open PR

Even when there are no code changes, always pass structured output v2 to `complete --structured-output-file`. Do not pass `sampledAccountIds` manually; the CLI derives them from the persisted review plan.

When code changes exist, follow the PR lifecycle in `references/remediation.md`. Advance the state machine until the PR is merged or otherwise reaches the expected ready state, then make exactly one terminal transition: `complete`, `fail`, or `timeout`.

## Failure policy

- Never complete a run as "no changes" when the plan is inconsistent, the ledger is incomplete, or a core review phase did not run.
- Do not bypass permission or security blocks through alternative mechanisms.
- The main coordinator may retry a failed subagent, but do not retry indefinitely. After a phase fails twice, record `review_incomplete`.
- Do not treat tmux or Claude process exit as the success condition. The database terminal status is the source of truth.
