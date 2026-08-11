---
name: weekly-crawl-review
description: Deterministic review plan と Claude Code subagents を使って、X/Twitter ラベリング品質を週次で監査・修正する。scripts/weekly-analyze.sh から無人実行される。
---

# Weekly Crawl Review

## Goal

週次で crawler のラベル品質を監査し、false positive だけでなく false negative、rule behavior mismatch、coverage gap、外部 threat gap を検出する。sampling と監査証跡は決定論的コードに任せ、Claude Code は evidence 解釈、外部調査、修正に集中する。

評価方針は `references/evaluation-methodology.md`、structured output は `references/result-contract.md`、外部調査は `references/external-research.md`、修正・PR は `references/remediation.md` を正本とする。

## Preconditions

- 現在地が disposable worktree で、`master` ではないことを確認する。
- `WEEKLY_ANALYSIS_RUN_ID`、`WEEKLY_REVIEW_PLAN_FILE`、`WEEKLY_REVIEW_RESULT_FILE` が設定されていることを確認する。
- `WEEKLY_REVIEW_PLAN_FILE` を読み、`seed == WEEKLY_ANALYSIS_RUN_ID`、`strategyVersion == risk-stratified/1` を確認する。
- plan が欠落・壊れている場合は独自 sampling に fallback しない。`WeeklyAnalysisRun` を failed にして終了する。
- DB への調査クエリは read-only にする。書き込みは run state/PR bookkeeping と明示された remediation のみとする。

## Procedure

### 1. Plan triage

`scripts/weekly-analysis-heartbeat.sh sampling` を呼ぶ。plan の label risk、sampleKind、selectionSignals を集計し、sample を最大 8 batch 程度に分ける。同一 label や同一 account を可能な限り同じ batch に寄せ、重複 DB 読み取りを減らす。

### 2. Parallel evidence review

次を同時に開始する。

- sample batch ごとに `weekly-review-sample-judge`。各 batch は read-only で blind-first 判定する。
- risk が高い label と最近変更された rule を `weekly-review-rule-auditor`。
- `weekly-review-researcher` に最新 spam/abuse context を調査させる。

sample judge の結果は coordinator が統合する。subagent が落ちた sample は消さず `skipped`、情報不足は `uncertain` にする。30 分を超える場合は `cross_checking` heartbeat を更新する。

### 3. Aggregate judgments

全 planned sample を 1 件ずつ ledger 化する。random audit と targeted audit を分離し、targeted の誤分類率を母集団 precision と呼ばない。

- classifier=true / judge=false → false positive candidate
- classifier=false / judge=true → false negative candidate
- judge が十分な根拠を持てない → uncertain
- 実行障害で確認できない → skipped + `review_incomplete`

単発例ではなく、同じ rule predicate・reason family・境界条件へ一般化できる pattern を remediation candidate にする。

### 4. Rule audit and external coverage

rule auditor の仕様乖離は `rule_behavior_mismatch` 候補として扱う。external research はローカル evidence と分離し、外部報告だけで auto-fix しない。

既存 `LabelMetricSnapshot`、`AccountLabelChange`、plan risk を使って topic/behavior coverage を確認する。高負荷な full-table `LIKE` scan を毎回の必須条件にしない。DB timeout で core phase が飛んだ場合は success 扱いで隠さず `review_incomplete` を出す。

`topic_nsfw`・`topic_politics` とその隣接カテゴリは既存 carve-out を維持する。観測は記録してよいが、ユーザーの明示的 sign-off なしに拡張・新規サブカテゴリ追加をしない。

### 5. Remediation

`scripts/weekly-analysis-heartbeat.sh implementing` を呼ぶ。修正が必要なら `references/remediation.md` に従い TDD で変更する。rule logic を変えたら version を bump する。

修正後は、変更対象 label の impact evaluation と変更 cohort 再レビューを行う。予想外の blast radius、無関係 cohort の大量反転、検証不能があれば変更を revert し、finding のみ残す。

### 6. Verify privacy and tests

実データのコピー・近似転載が変更ファイルに無いことを確認する。bio/tweet fixture は完全な架空データにする。

`scripts/weekly-analysis-heartbeat.sh verifying` を呼び、変更 package の check/format を実行する。既存環境起因の失敗と判断する場合も、変更前後で同じ失敗か確認し findings に残す。

### 7. Structured result v2

`scripts/weekly-analysis-heartbeat.sh recording` を呼ぶ。`references/result-contract.md` に従い schemaVersion 2 の JSON を必ず `$WEEKLY_REVIEW_RESULT_FILE` へ書く。これは supervisor が保持する durable diagnostics artifact であり、PR merge 後の復旧にも使う。全 planned sample に judgment を 1 件ずつ含める。

人間向け `findings` は日本語で作る。構造化 finding は enabled policy type のみを使う。実在 account の識別情報は Account ID 以外を含めない。

### 8. Complete or open PR

変更なしでも structured output v2 を必ず `complete --structured-output-file` に渡す。`sampledAccountIds` は保存済み review plan から CLI が導出するため手動で渡さない。

変更がある場合は `references/remediation.md` の PR lifecycle に従う。PR が merge/ready になるまで state machine を進め、最後に `complete`・`fail`・`timeout` のどれかを必ず 1 回成立させる。

## Failure policy

- plan 不整合、ledger 欠落、core review 未実施を「no changes」として完了しない。
- permission/security block を別手段で迂回しない。
- subagent の失敗は main coordinator が再実行してよいが、無限 retry はしない。2 回失敗した phase は `review_incomplete` として記録する。
- tmux/Claude プロセス終了そのものを run 成功条件にしない。DB の terminal status が正本である。
