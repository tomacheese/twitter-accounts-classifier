---
name: weekly-crawl-review
description: Weekly autonomous review of the crawler's labeling output — sample recent AccountLabel rows, spot-check them against real profile/tweet data, fix rule modules or crawler code as needed. Use when invoked by scripts/weekly-analyze.sh on its weekly schedule — distinct from verify-labeling-example, which checks one specific tweet/account the user reports rather than a scheduled broad sample.
---

# Weekly Crawl Review

## Goal

Once a week, autonomously check whether the crawler's label rules (`crawler/labels/rules/*.ts`)
are still producing sensible results against real, currently-collected data, and fix
anything that looks wrong — without waiting for human review (per project spec: this
project runs with no human-in-the-loop for this step).

`scripts/weekly-analyze.sh` invokes this skill inside a dedicated, disposable git worktree
(fixed path `.worktrees/weekly-crawl-review`), not in the repository's primary checkout.
That worktree is deleted automatically once the session ends, so nothing this skill does
needs to survive locally beyond opening the PR in step 8.

## Procedure

1. **Sample recent labels.** Query the `AccountLabel` table (via Prisma or `psql`) for the
   most recent `labeledAt` rows, grouped by `labelDefinition.key`. Pull a mix across all
   registered labels — do not only look at `blue_verified` once other labels exist from a
   future Phase 2.
   - **Sample size per label** scales with that label's total true-count (the number of
     `AccountLabel` rows with `value = true` for that `labelDefinition.key`), not a fixed
     number: if `true_count <= 20`, sample all of them (`sample_size = true_count`);
     otherwise sample `min(round(true_count * 0.10), 20)`, i.e. roughly 10% of the
     true-labeled rows, capped at 20. Examples: `true_count = 8` → sample 8 (all);
     `true_count = 50` → sample 5; `true_count = 300` → sample 20 (capped).
2. **Cross-check each sampled row by hand.** For each sampled `AccountLabel`, look at the
   `Account` row and its recent `Tweet` rows it was computed from, and judge — using your
   own reading of the bio/tweets/stats — whether the recorded `value` and `reason` still
   look correct. There is no ground-truth dataset; your own judgment (LLM-as-judge) is the
   standard, per the project spec.
3. **When you find a misclassification pattern** (not a single one-off, but something that
   would recur), locate the responsible rule module under `crawler/labels/rules/` (or the
   collection/mapping code under `crawler/twitter/` if the bug is upstream of labeling) and fix
   it. Bump the rule's `version` field when you change its logic, so future `AccountLabel`
   rows are distinguishable from ones produced by the old version.
4. **Research external spam-pattern context, every run.** Do a quick web search for
   current (recent) reporting on X/Twitter spam and abuse patterns, regardless of whether
   step 2 turned up a concrete misclassification — this is now a standing part of every
   run, not a reactive, conditional step. If the research surfaces a pattern not covered by
   an existing rule's keywords/logic (e.g. a new scam terminology cluster), that alone is
   sufficient justification to strengthen a rule; it no longer needs to be tied to an
   observed misclassification. Keep the same "recurring, not anecdotal" evidentiary bar
   that applies to patterns found in this project's own data (e.g. a pattern seen in only 3
   single-account tweets was correctly judged not to justify a new label because it was not
   a recurring pattern) — apply that same bar to externally-reported patterns before acting
   on them.
5. **Review topic-label coverage against the crawled account population.** Sample the
   bio-content distribution across currently crawled accounts (via `psql`/Prisma queries
   counting bios matching candidate keyword clusters — e.g. anime/manga, gaming,
   idol/fandom, sports, politics, NSFW/adult-content) and compare that prevalence against
   the existing `topic_*` labels' actual hit rate in the `AccountLabel` table. If a
   candidate topic is clearly more prevalent in the crawled population than an existing
   thin `topic_*` label and is not already covered by an existing label, add a new
   `topic_*` label rule for it, following the existing `topic_tech`/`topic_finance`/
   `topic_crypto` pattern: a simple bio-keyword regex rule under `crawler/labels/rules/`,
   registered in `crawler/labels/all-rules.ts`, with its own test file.
   - **Sensitive-category carve-out:** categories such as NSFW/adult-content and
     politics/partisan affiliation must be flagged as candidates in the run's findings, but
     must NOT be auto-added — adding a label for these categories requires explicit user
     sign-off first, unlike routine topic categories, because of their sensitivity. (In a
     prior manual run, NSFW and politics keyword clusters were both found present in the
     data but were deliberately left out of the labels added, specifically for this reason —
     treat that as the standing precedent.)
6. **Verify before committing.** Run `pnpm --filter crawler run check` (lint + typecheck +
   test for the crawler package). Do not commit if it fails — fix or revert instead.
7. **Record the run.** Insert a `WeeklyAnalysisRun` row (via a short Prisma script or
   `psql`) with `startedAt`, `finishedAt`, the sampled account IDs, and a short `findings`
   summary of what you changed and why (including any flagged-but-not-added sensitive
   topic candidates from step 5). Write the `findings` text in Japanese — it is rendered
   on the viewer WebUI's Weekly Runs page, which is Japanese-language.
8. **Open a PR and enable auto-merge.** Once branch protection with a required
   `Node CI / Check finished Node CI` status check is enabled on `master` (enabling branch
   protection itself is a separate, user-side operational task and is not performed by
   this skill), direct commits to `master` are rejected. Instead:
   1. The worktree starts out on a disposable `weekly-crawl-review-<timestamp>` branch, not
      `master` — create the real feature branch off of it with a Conventional Branch name,
      e.g. `git checkout -b fix/tighten-blue-verified-rule`.
   2. Commit with a Conventional Commit message, e.g.
      `fix(labels): tighten blue_verified rule for legacy verified_type values`, and push
      the branch.
   3. Open a PR: `gh pr create --fill`.
   4. Immediately enable GitHub's native auto-merge on it: `gh pr merge --auto --squash`.
   5. If CI passes, GitHub merges the PR into `master` automatically — no further action
      needed here. If CI fails, the PR stays open for the next run or a human to look at;
      `master` is never contaminated with a broken commit.
   Update `WeeklyAnalysisRun.commitSha` with the resulting merge commit hash once known
   (leave it unset if the run finishes before the PR merges — a later run's `psql`/Prisma
   update can backfill it, or it can stay unset for a "no changes needed" run).

## Constraints

- Do not add features outside of what a label-rule/data-quality fix requires. This is a
  correction pass, not a place to redesign the pipeline.
- Do not touch `data/config.json` or anything containing credentials.
- If you find nothing wrong in the sample, that is a valid outcome — still record the
  `WeeklyAnalysisRun` row noting "no changes needed" so the run history stays complete.
