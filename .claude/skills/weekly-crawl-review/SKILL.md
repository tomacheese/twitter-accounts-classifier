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

`scripts/weekly-analyze.sh` invokes this skill inside a dedicated, disposable git worktree,
not in the repository's primary checkout. そのパスは固定ではなく、起動のたびに作成される `WeeklyAnalysisRun` の実行 ID から `.worktrees/weekly-crawl-review-<実行ID>` として導出される (ブランチ名・tmux セッション名も同じ実行 ID を使う)。
`scripts/weekly-analyze.sh` はこの実行 ID を `WEEKLY_ANALYSIS_RUN_ID` 環境変数として、この skill を起動する tmux セッションに渡す。以降の全ての手順でこの環境変数を参照する。
That worktree is deleted automatically once the session ends, so
nothing this skill does needs to survive locally beyond opening the PR in step 9.

## Procedure

0. **Verify (or create) the disposable worktree.** This skill's write/commit steps must
   never run directly against the primary checkout. Before doing anything else, check
   whether the current working directory is already inside a disposable worktree on a
   non-`master` branch, and whether `WEEKLY_ANALYSIS_RUN_ID` is already set in the
   environment (as `scripts/weekly-analyze.sh` sets up when it invokes this skill on
   schedule, passing that variable to the tmux session it starts). If both are true, proceed
   to step 1. If not — e.g. this skill was invoked directly/manually and the session is
   sitting in the primary checkout on `master` with no `WEEKLY_ANALYSIS_RUN_ID` set — set up
   a worktree of your own before doing anything else, using a path and branch name distinct
   from the pattern `scripts/weekly-analyze.sh` derives from its own run ID
   (`.worktrees/weekly-crawl-review-<実行ID>` / `weekly-crawl-review-<実行ID>`):
   そのスーパーバイザーのクリーンアップ処理は、稼働中かどうかを確認せず、導出したパスに存在するものを無条件に強制削除する (`git worktree remove --force`、失敗時は `rm -rf`) ため、同じ実行 ID 由来のパスに手動で作った worktree があると、別のスケジュール起動と衝突して消される恐れがある。
   Instead, create `.worktrees/weekly-crawl-review-manual-<timestamp>` as a git worktree
   branched from `master`, with a `weekly-crawl-review-manual-<timestamp>` branch name, then
   copy `.env` and `.env.weekly-review` into it.
   さらに、後続の手順でハートビート呼び出しに使う `WEEKLY_ANALYSIS_RUN_ID` が未設定のままだとハートビートスクリプトがエラーになるため、手動起動の場合は自分で `pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts create` を実行し、返された ID を `WEEKLY_ANALYSIS_RUN_ID` としてこのセッションの環境変数に設定してから手順 1 に進む。
   Only then continue from step 1, working inside that worktree. If you created the worktree
   yourself here, remember to clean it up in step 11 once everything else is done.
1. **Sample recent labels.** この手順を始める前に `scripts/weekly-analysis-heartbeat.sh sampling` を呼ぶ。この手順が 30 分を超える見込みの場合は、途中でも同じフェーズ名で再度呼ぶこと。
   Query the
   `AccountLabel` table (via Prisma or `psql`) for the
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
2. **Cross-check each sampled row by hand.** この手順 (および手順 3 での修正作業) を始める前に `scripts/weekly-analysis-heartbeat.sh cross_checking` を呼ぶ。この手順が 30 分を超える見込みの場合は、途中でも同じフェーズ名で再度呼ぶこと。
   For each sampled `AccountLabel`, look at the
   `Account` row and its recent `Tweet` rows it was computed from, and judge — using your
   own reading of the bio/tweets/stats — whether the recorded `value` and `reason` still
   look correct. There is no ground-truth dataset; your own judgment (LLM-as-judge) is the
   standard, per the project spec.
3. **When you find a misclassification pattern** (not a single one-off, but something that
   would recur), locate the responsible rule module under `crawler/labels/rules/` (or the
   collection/mapping code under `crawler/twitter/` if the bug is upstream of labeling) and fix
   it. Bump the rule's `version` field when you change its logic, so future `AccountLabel`
   rows are distinguishable from ones produced by the old version.
4. **Research external spam-pattern context, every run.** この手順を始める前に `scripts/weekly-analysis-heartbeat.sh external_research` を呼ぶ。この手順が 30 分を超える見込みの場合は、途中でも同じフェーズ名で再度呼ぶこと。
   Do a quick web search for
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
5. **Review topic-label coverage against the crawled account population.** この手順を始める前に `scripts/weekly-analysis-heartbeat.sh coverage_review` を呼ぶ。この手順が 30 分を超える見込みの場合は、途中でも同じフェーズ名で再度呼ぶこと。
   Sample the
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
6. **Check for real Twitter/X data before committing.** この手順を始める前に `scripts/weekly-analysis-heartbeat.sh implementing` を呼ぶ。この手順が 30 分を超える見込みの場合は、途中でも同じフェーズ名で再度呼ぶこと。
   Re-read every rule file and every
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
7. **Verify before committing.** この手順を始める前に `scripts/weekly-analysis-heartbeat.sh verifying` を呼ぶ。この手順が 30 分を超える見込みの場合は、途中でも同じフェーズ名で再度呼ぶこと。
   Run
   `pnpm --filter crawler run check` (lint + typecheck + test for the crawler package). Do not
   commit if it fails — fix or revert instead.
8. **Record the run.**
   `WeeklyAnalysisRun` 行は既に `scripts/weekly-analyze.sh` が起動時に作成済みなので、ここで新しい行を直接 Prisma/`psql` で作らない。
   代わりに `scripts/weekly-analysis-heartbeat.sh recording` を呼び、この手順まで実行が生きていることを記録する。
   この手順で行うのはサンプルしたアカウント ID (`sampledAccountIds`) と、何を・なぜ変更したか (手順5 で見送った機微トピック候補を含む) の `findings` サマリを日本語でまとめ、手順11 に引き渡す準備だけである。
   完了・失敗・タイムアウトとしての確定は手順11 でまとめて行う。
   `findings` はビューア WebUI の Weekly Runs ページに表示されるため、必ず日本語で書く。

   あわせて、analyzer が ReviewFinding へ取り込む構造化結果を JSON ファイルへ書き出す。
   `findings` の日本語サマリは人間が読むためのもので、Attention Queue や Review 画面に
   出るのはこの構造化結果の方であるため、両方を必ず用意する。
   書き出し先は worktree の外 (例: `$CLAUDE_JOB_DIR/tmp/weekly-structured-output.json`、
   未設定なら `/tmp`) とし、リポジトリへコミットしない。形式は次のとおり。

   ```json
   {
     "schemaVersion": 1,
     "promptVersion": "weekly-crawl-review/1",
     "specVersion": "1",
     "modelIdentity": "<使用したモデル ID>",
     "toolIdentity": "claude-code",
     "repositoryCommit": "<git rev-parse HEAD の結果>",
     "targetFrom": "<レビュー対象期間の開始 (ISO 8601)>",
     "targetTo": "<レビュー対象期間の終了 (ISO 8601)>",
     "sourceRunId": "<$WEEKLY_ANALYSIS_RUN_ID>",
     "findings": [
       {
         "type": "possible_false_positive",
         "dimensions": { "label": "<LabelDefinition の id>", "rule": "<ルール key>" },
         "primaryScopeType": "label",
         "primaryScopeId": "<LabelDefinition の id>",
         "confidence": 0.8,
         "sampleCount": 12,
         "sampleReference": ["<Account の id>"],
         "evidenceReference": "<判断根拠を 1 行で>",
         "structuredMeasurement": { "falsePositiveCount": 5, "checkedCount": 12 },
         "suggestedSeverity": "medium"
       }
     ]
   }
   ```

   `type` は `analyzer/policy/detection-policy.json` に存在する enabled な rule の
   `type` と一致していなければ取り込み時に無視される。誤検出候補が 1 件も無かった場合は
   `findings` を空配列にする (ファイル自体は必ず出力する)。
   `sampleReference` にスクリーンネームや表示名など実在アカウントを特定できる値を
   入れないこと。`Account` の id のみを使う。
9. **Open a PR and enable auto-merge.** Once branch protection with a required
   `Node CI / Check finished Node CI` status check is enabled on `master` (enabling branch
   protection itself is a separate, user-side operational task and is not performed by
   this skill), direct commits to `master` are rejected. Instead:
   1. The worktree starts out on a disposable `weekly-crawl-review-<実行ID>` branch, not
      `master` — create the real feature branch off of it with a Conventional Branch name,
      e.g. `git checkout -b fix/tighten-blue-verified-rule`.
   2. Commit with a Conventional Commit message, e.g.
      `fix(labels): tighten blue_verified rule for legacy verified_type values`, and push
      the branch.
   3. PR を作成する前に `scripts/weekly-analysis-heartbeat.sh opening_pull_request` を呼ぶ。
   4. Open a PR: `gh pr create --fill`。返された PR 番号・URL を控える。
   5. `pnpm --filter crawler exec tsx scripts/weekly-analysis-run.ts record-pr --id "$WEEKLY_ANALYSIS_RUN_ID" --pull-request-number <番号> --pull-request-url <URL>` を呼び、
      `complete` を待たずに `WeeklyAnalysisRun.pullRequestNumber`・`pullRequestUrl` を記録する。
   6. `pnpm --filter crawler exec tsx scripts/weekly-analysis-github.ts request-review --pr <番号> --reviewer book000` を実行し、レビュアーとして `book000` を指定する。
   7. `pnpm --filter crawler exec tsx scripts/weekly-analysis-github.ts enable-auto-merge --pr <番号>` を実行し、GitHub ネイティブのオートマージを有効化する。
   8. 控えた PR 番号を手順10・11 に引き渡す。
   9. If CI passes, GitHub merges the PR into `master` automatically — no further action
      needed here. If CI fails, the PR stays open for the next run or a human to look at;
      `master` is never contaminated with a broken commit. 実際の終了コードごとの分岐は手順10 で行う。
10. **CI・レビューを待つ。**
    `scripts/weekly-analysis-wait-pr.sh <PR番号>` を呼び、その終了コードに応じて次のように分岐する (このスクリプトはポーリング中も内部で待機フェーズのハートビートを送るため、この手順自体で追加のハートビート呼び出しは不要)。
    - `0` (ready/merged): 手順11 (実行を終端させる) に進む。
    - `1` (review_required): レビュースレッドへの対応を行う。最大 2 回の修正・再確認サイクルまでとし、3 回目に到達した場合は `scripts/weekly-analysis-run.ts fail` で実行を失敗として終端させる。
      PR はクローズせず残す (人による確認を残すため)。
    - `2` (failed_checks): CI ログを確認し、修正してプッシュし直し、再度この手順を実行する。同一 PR に対する CI 失敗からの修正試行が 2 回を超えた場合は、レビュー未解決の場合と同様に `fail` で終端させる。
    - `3` (timeout): `scripts/weekly-analysis-run.ts timeout` で実行をタイムアウトとして終端させる。
      PR は開いたままにし、次回のスーパーバイザー起動時の整合性確認 (`scripts/weekly-analyze.sh`) に委ねる。
    - `4` (merge_blocked): コンフリクトを解消してプッシュし直し、再度この手順を実行する。
    - `5` (auto_merge_disabled): `enable-auto-merge` を再実行し、再度この手順を実行する。
    - `6` (run_terminal): 既に別経路でこの実行が終端している。何もせず終了する。
    - `7` (execution_error): `scripts/weekly-analysis-run.ts fail` で実行を失敗として終端させる。
    - `8` (closed): PR がマージされずにクローズされている。`scripts/weekly-analysis-run.ts fail` で実行を失敗として終端させる。
11. **実行を終端させる。**
    ここまでのどの経路をたどった場合でも、必ず `complete`・`fail`・`timeout` のいずれかを一度だけ呼んで `WeeklyAnalysisRun` を終端状態にする。
    手順2 (クロスチェック) で変更不要と判断した「no_changes」の場合は、PR を作らず `scripts/weekly-analysis-run.ts complete --id "$WEEKLY_ANALYSIS_RUN_ID" --findings "<変更不要の理由>"` を直接呼ぶ。
    それ以外の場合は、手順9 で控えた PR 番号・URL を `--pull-request-number`・`--pull-request-url` に渡し、手順8 で用意した `sampledAccountIds`・`findings` と併せて `complete` を呼ぶ。
    いずれの経路でも、手順8 で書き出した構造化結果のパスを
    `--structured-output-file <パス>` として `complete` に渡す。これを渡さないと
    `weekly_review_ingest` が取り込む内容を持たず、レビュー結果が ReviewFinding に
    反映されないまま実行だけが成功として終わる。
    その後、**手順0 で worktree を自分で作成していた場合に限り**、worktree の後片付けを行う。
    `scripts/weekly-analyze.sh` が用意した worktree で実行していた場合はこの後片付けを一切行わない (その worktree の削除はスーパーバイザー側の責務であり、セッション終了後に自動で行われる)。
    1. Move back out of the worktree to the primary checkout first — a worktree cannot
       remove itself while it is the current working directory.
    2. Remove the manual worktree you created in step 0, at
       `.worktrees/weekly-crawl-review-manual-<timestamp>` (using the actual path from step
       0) — never `scripts/weekly-analyze.sh`'s own run-ID-derived worktree, which belongs to
       that script and must never be touched here:
       `git worktree remove --force .worktrees/weekly-crawl-review-manual-<timestamp>`. If
       that fails, fall back to `rm -rf .worktrees/weekly-crawl-review-manual-<timestamp>`
       followed by `git worktree prune`, matching the pattern already used elsewhere in this
       project's tooling for removing a worktree.
    3. Delete the throwaway branch created in step 0 with
       `git branch -D weekly-crawl-review-manual-<timestamp>` (using the actual branch name
       from step 0). This only removes that throwaway branch — it must not touch any separate
       feature branch (e.g. `fix/...`) created and pushed in step 9, which already lives on
       the remote and is unrelated to this cleanup, nor `scripts/weekly-analyze.sh`'s own
       run-ID-derived branch.

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
- 実行の終端判定を Claude プロセス自体の終了に委ねてはならない。
  `scripts/weekly-analyze.sh` は `WeeklyAnalysisRun` の DB 上のステータスだけを見て完了・失敗・タイムアウトを判定するため、プロセスが単に終了しただけでは running のまま取り残される。
  手順11 で `complete`・`fail`・`timeout` のいずれかを必ず呼び、DB 上のステータスを確定させること。

## Constraints

- Do not add features outside of what a label-rule/data-quality fix requires. This is a
  correction pass, not a place to redesign the pipeline.
- Do not touch `data/config.json` or anything containing credentials.
- If you find nothing wrong in the sample, that is a valid outcome — still record the
  `WeeklyAnalysisRun` row noting "no changes needed" so the run history stays complete.
- レビュー対応・CI 修正のいずれも、同一 PR に対して最大 2 回の修正・再確認サイクルまでとする。
  3 回目に到達した場合は手順11 の通り `fail` で実行を終端させ、それ以上サイクルを繰り返さない。
