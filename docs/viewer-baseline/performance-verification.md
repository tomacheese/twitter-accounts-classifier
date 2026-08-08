# Viewer 新画面 性能検証手順

本番相当データを要するため CI では実行せず、release 前に運用者が手動実行する。
実データそのもの (screen name、bio、tweet 本文) はこのファイルへ転記しない。

## 検証環境の準備

1. 本番相当規模のデータを用意する。目安として `Account` 100 万件、`AccountLabelLatest` 1,000 万件超。
   既存の本番相当環境の複製、または `crawler` のシード処理を反復実行した合成データのいずれかでよい。
2. `analyzer` の read model 生成ジョブ (`buildOrUpdateCrawlCycle`・各 `publishGeneration`) を実データ相当の頻度で流し、
   `AccountSummaryCurrent`・`LabelSummaryCurrent`・`ReviewFinding` 等の read model テーブルも
   本番相当の行数まで積み上げる。
3. `docker compose -f compose.yaml up postgres` と同じ `shared_buffers`・`work_mem` 設定で計測する。
   開発機のデフォルト設定のまま計測すると、実運用と乖離した実行計画になりうる。

## 負荷試験の実行方法

1. 対象画面: `/overview`・`/review`・`/accounts`・`/accounts/[accountId]`・`/labels`・`/labels/[labelKey]`・
   `/operations`・`/operations/{crawl,review,block}/[cycleId]`・`/blocks`・`/blocks/[blockId]`・`/system`。
2. 各画面の初回表示 (cold) と 2 回目以降 (warm) の TTFB を計測する。Next.js の `force-dynamic` ページは
   毎回サーバー側でクエリを実行するため、warm/cold の差はほぼ DB 接続確立・OS 側キャッシュの差になる。
3. 各画面の初期 HTML サイズを計測する (`curl -s -o /dev/null -w '%{size_download}\n'` 等)。
4. Route Handler (`/api/*`) は代表的なクエリパラメータの組み合わせ (フィルタあり/なし、cursor あり/なし) で
   レスポンスタイムを計測する。

## `EXPLAIN (ANALYZE, BUFFERS)` の取得・比較方法

1. 対象クエリは各 `viewer/lib/queries/*.ts` が発行する SQL を Prisma のクエリログ (`log: ['query']`) から採取する。
2. 採取した SQL に `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)` を付けて本番相当データに対して実行し、
   結果を `docs/viewer-baseline/explain/` 配下の対応するファイルへ追記する
   (`docs/viewer-baseline/explain/dashboard.txt` 等、Task 1 のベースラインと同じ命名規則を使う)。
3. `viewer/lib/queries/seq-scan.test.ts` は `AccountSummaryCurrent`・`LabelSummaryCurrent` に対する
   代表クエリが Seq Scan を行わないことを機械的に検証するが、これは実行計画の形だけの確認であり、
   実際のレイテンシは本番相当データでの `ANALYZE, BUFFERS` 計測でのみ判断できる。
   この検証は `DATABASE_URL` の設定された Postgres 接続を要するため、他の viewer テストと異なり
   `pnpm --filter viewer test` の実行前に接続先を用意する必要がある。

## Task 1 のベースラインとの比較観点

`docs/viewer-baseline/2026-08-07-baseline.md` に記録した旧画面の値と、新画面の計測値を次の観点で比較する。

- TTFB (cold/warm) が旧画面の値を上回っていないか。上回っている場合、どのクエリ・どの Route Handler が
  ボトルネックかを `EXPLAIN (ANALYZE, BUFFERS)` の `Execution Time`・`Buffers` から特定する。
- 初期 HTML サイズが旧画面より大きく増えていないか。Overview の Attention Queue・Operations の Cycle 一覧など、
  1 ページあたりの表示件数に上限を設けているセクションで、上限が守られているか確認する。
- 主要クエリの実行計画に旧画面のベースラインには無かった Seq Scan が新たに現れていないか。
- error rate が旧画面と同等以下か。`ReadModelState.status` が `failed`/`unknown` の間、新画面は
  最後に成功した read model を表示し続ける設計のため、read model 生成側の失敗が viewer 側の
  error rate に直結していないかも合わせて確認する。
