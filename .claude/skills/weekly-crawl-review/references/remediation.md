# Remediation and PR contract

Remediate confirmed misclassification, specification drift, or coverage gaps in the same run when the fix is safely reviewable and proportionate to the weekly-review PR. Do not change a rule blindly because of one ambiguous example; investigate until it is fixed, disproved as `verified_not_issue`, or qualifies for explicit GitHub Issue deferral.

When remediating:

1. Add a failing unit or regression test first.
2. Make the smallest rule change that fixes the defect, and bump the version of every rule whose logic changes.
3. Recheck that no strings derived from real crawl data remain in tests, comments, or documentation.
4. Run `pnpm --filter crawler run check` and formatting checks.
5. For each changed label, run a read-only impact evaluation and inspect the number and direction of changes: true-to-false and false-to-true. Do not merge an unexpectedly broad blast radius.
6. Re-evaluate a sample from the changed cohort and confirm that the result matches the remediation intent.
7. Continue until every finding has `fixed`, `verified_not_issue`, or `deferred_to_issue`. Use deferral only for `human_judgment_required` or `oversized_scope`. Search open Issues first; if no exact match exists, create the GitHub Issue before completing. Record `issueNumber` and `issueUrl` in the resolution.

Use the existing supervisor and state machine for the PR lifecycle. Before PR creation, follow the heartbeat, `record-pr`, review request, auto-merge, and `weekly-analysis-wait-pr.sh` sequence. Limit review/CI remediation to at most two cycles in the same PR; fail the run if more cycles are required.
