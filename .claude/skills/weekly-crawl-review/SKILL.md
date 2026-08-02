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
needs to survive locally beyond opening the PR in step 9.

## Procedure

0. **Verify (or create) the disposable worktree.** This skill's write/commit steps must
   never run directly against the primary checkout. Before doing anything else, check
   whether the current working directory is already inside a disposable worktree on a
   non-`master` branch (as `scripts/weekly-analyze.sh` sets up when it invokes this skill
   on schedule). If it is, proceed to step 1. If it is not — e.g. this skill was invoked
   directly/manually and the session is sitting in the primary checkout on `master` — set
   up a worktree of your own before doing anything else, using a path and branch name
   distinct from the cron script's fixed `.worktrees/weekly-crawl-review` /
   `weekly-crawl-review-<timestamp>` naming: `scripts/weekly-analyze.sh`'s cleanup logic
   force-removes (`git worktree remove --force`, falling back to `rm -rf`) anything at that
   fixed path purely because it exists there, with no liveness check, so a manually-created
   worktree at that same path would be deleted out from under you if a scheduled run fires
   while you're still using it. Instead, create
   `.worktrees/weekly-crawl-review-manual-<timestamp>` as a git worktree branched from
   `master`, with a `weekly-crawl-review-manual-<timestamp>` branch name, then copy `.env`
   and `.env.weekly-review` into it. Only then continue from step 1, working inside that
   worktree. If you created the worktree yourself here, remember to clean it up in step 10
   once everything else is done.
1. **Sample recent labels.** Query the `AccountLabel` table (via Prisma or `psql`) for the
   most recent `labeledAt` rows, grouped by `labelDefinition.key`. Pull a mix across all
   registered labels — do not only look at `blue_verified` once other labels exist from a
   future Phase 2.
   - **Note on `psql`:** Prisma models use camelCase column names (e.g. `labeledAt`). When
     querying directly via `psql` rather than through Prisma, double-quote camelCase
     identifiers (e.g. `"labeledAt"`), or Postgres will lowercase them implicitly and error
     with "column does not exist".
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
   - **Sensitive-category carve-out:** `topic_nsfw` (`crawler/labels/rules/topic-nsfw.ts`)
     and `topic_politics` (`crawler/labels/rules/topic-politics.ts`) already exist and are
     registered in `crawler/labels/all-rules.ts` — that part is a fact about the current
     codebase. However, there is no historical record confirming their addition actually
     went through the explicit user sign-off this carve-out requires; their presence in the
     repository is not itself evidence of sign-off. Treat them as still within the
     carve-out: continue to report their observed hit rates/behavior in this run's findings
     (step 8) as you would for any flag-only candidate, and do not treat their mere
     existence as license to expand them or auto-add further NSFW/politics sub-categories
     without separately obtaining sign-off. The carve-out (flag-only, no auto-add without
     explicit user sign-off) applies to any new/expanded NSFW- or politics-adjacent
     category, including sub-categories not covered by these two existing labels (e.g. a
     narrower sub-cluster within adult content or partisan affiliation that the existing
     rule's keywords don't catch) — such sub-categories must be flagged as candidates in the
     run's findings, but must NOT be auto-added.
6. **Check for real Twitter/X data before committing.** Re-read every rule file and every
   test file you added or modified in steps 3 and 5 this run, and specifically scan any
   bio/tweet example strings, comments, or fixture data for text that was copied — in whole
   or in part — from a real crawled account you viewed while cross-checking in step 2. Being
   "inspired by" a real example you saw is fine; the actual string content is not allowed to
   match real observed text. Rewrite anything that does as fiction, preserving the property
   the case is meant to demonstrate (per `CLAUDE.md`'s guidance: language, length, keyword
   patterns, threshold relationships, match/no-match expectations). This check applies even
   to text that felt like a natural, obvious example to jot down during the investigation —
   the risk is exactly that real bio/tweet text gets pasted or closely paraphrased while it
   is still fresh from having just been read off a `psql`/Prisma query result in step 2. Do
   not proceed to step 7 until this scan is done and clean.
7. **Verify before committing.** Run `pnpm --filter crawler run check` (lint + typecheck +
   test for the crawler package). Do not commit if it fails — fix or revert instead.
8. **Record the run.** Insert a `WeeklyAnalysisRun` row (via a short Prisma script or
   `psql`) with `startedAt`, `finishedAt`, the sampled account IDs, and a short `findings`
   summary of what you changed and why (including any flagged-but-not-added sensitive
   topic candidates from step 5). Write the `findings` text in Japanese — it is rendered
   on the viewer WebUI's Weekly Runs page, which is Japanese-language.
9. **Open a PR and enable auto-merge.** Once branch protection with a required
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
10. **Clean up the worktree, but only if step 0 created it for you.** Skip this step
   entirely if this run started inside a worktree already set up by
   `scripts/weekly-analyze.sh` — that script owns cleanup for its own worktree and deletes
   it after the session ends. Otherwise (step 0 created the worktree because this skill was
   invoked directly/manually), remove it now that all other steps are finished (after step
   9's PR/auto-merge, or after step 8 for a "no changes needed" run with no PR):
   1. Move back out of the worktree to the primary checkout first — a worktree cannot
      remove itself while it is the current working directory.
   2. Remove the manual worktree you created in step 0, at
      `.worktrees/weekly-crawl-review-manual-<timestamp>` (using the actual path from step
      0) — never the cron script's own fixed `.worktrees/weekly-crawl-review` worktree, which
      belongs to `scripts/weekly-analyze.sh` and must never be touched here:
      `git worktree remove --force .worktrees/weekly-crawl-review-manual-<timestamp>`. If
      that fails, fall back to `rm -rf .worktrees/weekly-crawl-review-manual-<timestamp>`
      followed by `git worktree prune`, matching the pattern already used elsewhere in this
      project's tooling for removing a worktree.
   3. Delete the throwaway branch created in step 0 with
      `git branch -D weekly-crawl-review-manual-<timestamp>` (using the actual branch name
      from step 0). This only removes that throwaway branch — it must not touch any separate
      feature branch (e.g. `fix/...`) created and pushed in step 9, which already lives on
      the remote and is unrelated to this cleanup, nor the cron script's own
      `weekly-crawl-review-<timestamp>` branch.

## Execution model

- This skill's design (no human-in-the-loop) is about not pausing for human review — it is
  not a mandate to run via a sub-agent. In practice, delegating the write-heavy portion of
  this workflow (DB writes, rule-file edits, `git commit`/push, PR creation, enabling
  auto-merge) to a sub-agent via the `Agent` tool, foreground or background, has been
  denied by Claude Code's auto-mode permission classifier. If that happens, run those steps
  directly in the main session instead of retrying delegation.
- This skill runs unattended — invoked by `scripts/weekly-analyze.sh` on a schedule, with no
  user present to respond — so it must never use an interactive confirmation/question tool
  to ask the user something and wait for a reply. When an ordinary decision point comes up
  during the run (e.g. environment/prerequisite setup choices, whether to keep or revert a
  content change, how to phrase a finding), choose the most conservative/documented option
  yourself, proceed, and record the decision and its reasoning in `WeeklyAnalysisRun.findings`
  (step 8) so it is auditable after the fact — do not pause and wait for a human. This does
  not extend to genuine permission or security blocks: if an action is refused by a
  permission system, security control, or classifier for a reason other than the already-
  documented sub-agent-delegation case above, that is not an ordinary decision point to route
  around — stop, leave the refused action undone, and record in `findings` what was attempted
  and why it was blocked.

## Constraints

- Do not add features outside of what a label-rule/data-quality fix requires. This is a
  correction pass, not a place to redesign the pipeline.
- Do not touch `data/config.json` or anything containing credentials.
- If you find nothing wrong in the sample, that is a valid outcome — still record the
  `WeeklyAnalysisRun` row noting "no changes needed" so the run history stays complete.
