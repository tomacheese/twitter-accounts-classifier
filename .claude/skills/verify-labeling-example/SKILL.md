---
name: verify-labeling-example
description: Verify whether the crawler's label rules correctly judge a specific tweet/account the user reports, by crawling the exact tweet if needed and evaluating every rule against it — distinct from design-labeling-rules (new label category from a broad sample) and weekly-crawl-review (scheduled review with no specific example in hand).
---

# Verify Labeling Example

## Goal

When the user hands you one or more specific tweet/account URLs and asks whether the crawler's labeling correctly judges them, diagnose the actual cause of any unexpected result — a data-capture gap, a rule-logic gap, or already-correct behavior — rather than guessing from partial data.

## Procedure

1. Extract the tweet ID(s)/screen name(s) from the provided URL(s).
2. Check whether the account(s) and the specific tweet(s) already exist in the database (`Account`/`Tweet` tables via `psql`).
3. **If the specific tweet or its replies are missing or incomplete**, run `node dist/crawl-tweet.js <tweetId>` inside the crawler container before doing anything else. Do not conclude a rule is "not working" based on data that was never actually crawled — a `false` result caused by a missing tweet looks identical to a `false` result caused by a rule gap, and only actually fetching the data distinguishes them.
4. Evaluate every registered label rule against the specific account(s) in question. This does not require a full-population `relabel` backfill — write or reuse a scoped evaluation limited to the account(s) at hand (build each account's `AccountFeatureBundle` and call `registry.applyAll(bundle)` directly), since `relabel.js` only enqueues async work for the worker queue rather than returning an immediate result, and this workflow only needs a handful of accounts checked.
5. Compare the actual rule outputs against what the user expects, and report which case applies:
   - **Data-capture gap**: the pattern's evidence wasn't crawled at all until step 3 crawled it.
   - **Rule-logic gap**: the evidence exists, but no current rule's logic covers this pattern shape, or an existing rule's logic covers it but produces the wrong verdict.
   - **Correct as-is**: existing rules already produce the expected result.
6. If a rule-logic gap is found, hand off — this skill's job is diagnosis, not implementation. Route "the pattern needs a brand-new label category" to `design-labeling-rules`, and "an existing rule's threshold/logic needs adjustment" to `weekly-crawl-review`'s fix process. Do not implement rule changes directly inside this skill.

## Constraints

- Do not touch `data/config.json` or anything containing credentials.
- Do not run `relabel.js` from within this skill — even though it now only enqueues stale `(account, rule)` pairs as `account_relabel` work items rather than evaluating them inline, the actual evaluation still runs asynchronously via the relabel-worker queue on the relabeler service's next poll cycle, so it does not give you an immediate, scoped answer for the account(s) at hand; the scoped per-account evaluation in step 4 is sufficient for verifying specific reported examples.
