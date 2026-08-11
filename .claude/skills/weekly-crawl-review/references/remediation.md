# Remediation and PR contract

修正は systematic な誤分類・仕様乖離・coverage gap に限定する。単発の曖昧例だけで rule を変更しない。

修正時:

1. 失敗する unit/regression test を先に追加する。
2. 最小の rule 修正を行い、ロジックを変更した rule は version を bump する。
3. 実クロールデータ由来の文字列が test/comment/doc に残っていないことを再確認する。
4. `pnpm --filter crawler run check` と format を通す。
5. 変更した label は read-only impact evaluation を行い、変更件数と true→false / false→true の方向を確認する。予想外に広い blast radius は merge しない。
6. 変更 cohort の sample を再判定し、修正意図と一致することを確認する。

PR lifecycle は既存 supervisor/state machine を使う。PR 作成前に heartbeat、`record-pr`、review request、auto-merge、`weekly-analysis-wait-pr.sh` を順守する。review/CI 修正は同一 PR で最大 2 cycle とし、それを超えたら run を failed にする。
