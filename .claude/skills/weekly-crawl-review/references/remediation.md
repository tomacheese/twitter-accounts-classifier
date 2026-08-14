# Remediation and PR contract

Remediate every confirmed misclassification, specification drift, or coverage gap in the same run. Do not change a rule blindly because of one ambiguous example; investigate the example until it is either confirmed as a defect and fixed or disproved and recorded as `verified_not_issue`. If neither outcome can be established safely, fail the run instead of deferring the finding.

When remediating:

1. Add a failing unit or regression test first.
2. Make the smallest rule change that fixes the defect, and bump the version of every rule whose logic changes.
3. Recheck that no strings derived from real crawl data remain in tests, comments, or documentation.
4. Run `pnpm --filter crawler run check` and formatting checks.
5. For each changed label, run a read-only impact evaluation and inspect the number and direction of changes: true-to-false and false-to-true. Do not merge an unexpectedly broad blast radius.
6. Re-evaluate a sample from the changed cohort and confirm that the result matches the remediation intent.
7. Continue until every finding has a terminal `fixed` or `verified_not_issue` resolution. Do not create a successful PR/run that lists known problems as follow-up work.

Use the existing supervisor and state machine for the PR lifecycle. Before PR creation, follow the heartbeat, `record-pr`, review request, auto-merge, and `weekly-analysis-wait-pr.sh` sequence. Limit review/CI remediation to at most two cycles in the same PR; fail the run if more cycles are required.
