---
name: design-labeling-rules
description: Design and implement brand-new label rule modules (e.g. spam, adsense, bot, ai-generated, topic, or any other category not yet covered) by sampling accumulated crawl data and researching known patterns externally. Use when a new label category is proposed — distinct from weekly-crawl-review (reviews already-existing rules on a schedule) and verify-labeling-example (the user hands you one specific tweet/account to check).
---

# Design Labeling Rules

## Goal

When a new label category is proposed for this project, design and implement it from
real, currently-collected data rather than guessing — so the resulting rule's keywords
and thresholds are grounded in what this project's accounts actually look like, plus
any external research needed to fill gaps the sample alone doesn't cover.

## Procedure

1. **Sample accumulated data.** Query the `Account` and `Tweet` tables (via `psql` through
   the project's Docker Compose network, same access pattern as `weekly-crawl-review`) for
   a representative cross-section of bios and tweet text — not only accounts that already
   carry some other label.
2. **Identify candidate patterns from the sample.** Read the sampled bios/tweets by hand
   and note concrete, recurring patterns that justify the new category (e.g. solicitation
   phrasing, promotional language, mechanical posting behavior, self-declared AI-generated
   content, a recognizable topic). Do not invent a pattern with no support in the sample.
3. **Web research.** For each candidate pattern, research known examples elsewhere (e.g.
   common spam/adsense bio phrasing, signs of scripted posting, common AI-generated text
   patterns) to sharpen the keyword list or threshold. Only fold in a finding if it
   explains something you actually observed in step 2.
4. **Design and implement the rule module.** One file per label under
   `crawler/labels/rules/`, exporting a `LabelRule` per the interface in `crawler/labels/types.ts`
   (same shape as the existing `blue-verified.ts`). Combine multiple signals — keyword/regex
   matches on bio and tweet text, and numeric features already present on
   `AccountFeatureBundle` (follower/following ratio, tweet cadence, reply ratio, etc.) — into
   a `confidence` between 0 and 1 that reflects how many signals agree, not a constant 1.
5. **Register the rule** in `runCrawlCycle()` in `crawler/crawl.ts`, alongside the existing
   `registry.register(...)` calls.
6. **Confirm `ensureLabelDefinitions()` still covers every registered rule generically**
   (it iterates `registry.getAll()` as of Phase 2 — if a future change reverts this to a
   hardcoded list, restore the generic version instead of hardcoding the new rule).
7. **Write a unit test for the rule**, covering a clear-positive case, a clear-negative
   case, and at least one boundary case, using mocked `AccountFeatureBundle` values.
8. **Verify against real data.** Run the crawler (or a scoped script) against the currently
   accumulated accounts, then spot-check a sample of the newly produced `AccountLabel` rows
   by hand (LLM-as-judge — there is no ground-truth dataset for this project). Adjust
   keywords/thresholds if a sampled row looks wrong, and re-verify.
9. **Verify the full suite.** Run `pnpm run check` (lint + typecheck + test). Do not
   proceed to commit if it fails.
10. **Commit.** If this skill runs as part of planned, interactive implementation work
    (a branch created via `superpowers:using-git-worktrees`), integrate via
    `superpowers:finishing-a-development-branch` (local merge — this repository has no
    GitHub remote, so never push or open a PR). If instead invoked ad hoc outside of a
    planned session, commit directly to `master`, matching `weekly-crawl-review`'s
    convention, since this repository has no PR flow.

## Constraints

- Do not change the `LabelRule`/`LabelRuleRegistry` interfaces — new rules must fit the
  existing contract.
- Do not add a live LLM call inside any `evaluate()` — heuristics only. LLM judgment is
  for this skill's own design process (steps 2-3, 8) and for `weekly-crawl-review`'s
  ongoing review, not for the runtime rule itself.
- Do not touch `data/config.json` or anything containing credentials.
- If sample data doesn't clearly support a candidate category or pattern, don't force it
  in — a smaller, well-supported rule set is better than a padded one.
