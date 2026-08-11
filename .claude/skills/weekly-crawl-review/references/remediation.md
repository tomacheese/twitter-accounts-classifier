# Remediation and PR contract

Limit remediation to systematic misclassification, specification drift, or coverage gaps. Do not change a rule because of a single ambiguous example.

When remediating:

1. Add a failing unit or regression test first.
2. Make the smallest rule change that fixes the defect, and bump the version of every rule whose logic changes.
3. Recheck that no strings derived from real crawl data remain in tests, comments, or documentation.
4. Run `pnpm --filter crawler run check` and formatting checks.
5. For each changed label, run a read-only impact evaluation and inspect the number and direction of changes: true-to-false and false-to-true. Do not merge an unexpectedly broad blast radius.
6. Re-evaluate a sample from the changed cohort and confirm that the result matches the remediation intent.

Use the existing supervisor and state machine for the PR lifecycle. Before PR creation, follow the heartbeat, `record-pr`, review request, auto-merge, and `weekly-analysis-wait-pr.sh` sequence. Limit review/CI remediation to at most two cycles in the same PR; fail the run if more cycles are required.
