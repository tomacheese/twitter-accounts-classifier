# 旧 DB から新 DB への移行ツール

旧 DB (text ID、旧ラベル表 `AccountLabelLatest`) の行を、変換しながら新 DB (baseline 適用済み) へバイナリ COPY のパイプで流し込み、検証ゲートを通す一式。旧 DB は読み取りしかしない。新 DB の作成は [README.md](./README.md) を参照する。

## ファイル

| ファイル | 内容 |
| --- | --- |
| `transform/*.sql` | 旧 DB 側で実行する、テーブルごとの変換 SELECT。ヘッダのコメント (`target`、`columns`、`scope`、`big`、`from`、`format`) が列の対応表とスコープを定める |
| `finalize/*.sql` | 新 DB 側で、stg (作業用の表) から組み立てる SQL。`20_labels` がラベル保存、`21_work` が text id から int id への変換 |
| `prepare-new.sql` | 新 DB に mig (進捗、変換表、退避した定義) と stg を作る |
| `load.sh` | `prepare`、`load`、`restore`、`cleanup` の各フェーズ。テーブル単位で並列、step 単位で再開できる |
| `verify.sh`、`verify/*.sql` | 検証ゲート |
| `rehearsal.sh` | 1% シャードの通しリハーサル。Tweet のパーティション方式の比較と計測を含む |
| `bench-tweet.sh`、`fio.sh`、`seqslice.sh` | Tweet 方式の比較用の計測、新 DB ボリュームのディスク性能、表の物理順の逐次読み出しと新 DB への投入速度のスライス計測 |
| `apply-baseline.sh` | 新 DB に baseline、Tweet の方式別 SQL、functions.sql を適用する (`--reset` で作り直す) |
| `lib.sh`、`tools/` | 共通関数、Tweet の振り分け (`tweet-route.py`)、計測の集計 |
| `testdata/seed-old.sql` | 旧スキーマへ入れる架空のデータ。自己テスト用で、実在のデータは含まない |

## 流れ

```text
prepare  旧 DB のスナップショットを取り、LabelDefinition の変換表とシャードのアカウント一覧を作る。
         新 DB 側で FK と巨大表のインデックスを退避して外し、ACL などのトリガーを止め、Tweet の子パーティションを切り離す。
load     transform/*.sql の各 step を、旧 DB の読み取り専用トランザクションから COPY ... FREEZE で新 DB へ流す。
         ラベルは stg.label_row へ流し、finalize が AccountLabelState、AccountActiveLabel、LabelRuleVersion を組み立てる。
         Tweet は、行を子パーティションごとに振り分け、子を作ったトランザクションで COPY ... FREEZE してから attach する。
restore  退避したインデックス、制約、FK を作り直し (FK はこの時に全行が検証される)、VACUUM (FREEZE, ANALYZE) する。
verify   検証ゲートを実行する。
cleanup  mig と stg を落とす (切り替えの前に実行する。検証が終わるまでは残す)。
```

全量は `ops/db-rebuild/load.sh all`、1% シャードは `SHARD=0/100 ops/db-rebuild/load.sh all`。同じ環境で `verify.sh` を続けて実行する。

## 設計上の決定

- **スナップショットの共有**: 旧 DB が動いている間 (リハーサル) も、件数とハッシュが一致するよう、`pg_export_snapshot()` のスナップショットを全セッションで共有する。保持するセッションは最大 `SNAPSHOT_MAX_HOURS` (既定 6) 時間で自動的に終わる。旧 DB の更新を止めた切り替え本番では `NO_SNAPSHOT=1` で省ける。
- **旧ホストへの負荷**: 旧ホストの load average は backfill などで自然に上下する (リハーサルでは、移行を止めた状態でも 12 から 19 の間を数分で往復した)。そのため `LOAD_LIMIT` (既定 16) を超えた瞬間には中断せず、`LOAD_LIMIT - 2` を超えている間は次の問い合わせを始めずに待つ。`LOAD_ABORT_SECS` (既定 1800) 待っても下がらない場合と、アプリのコンテナが止まった場合、エラー行が急増した場合に中断する。待った時間は `$WORK_DIR/load-wait.secs` に残る。
- **バッチ**: シャード実行はアカウント ID の配列 (`ID_BATCH` 件ずつ)、全量の巨大表は TID 範囲 (`CTID_BLOCKS` ブロックずつ、逐次読み出し) で問い合わせを分け、各バッチを一時ファイルに受けて再試行できるようにする。バイナリ COPY は、バッチごとのヘッダとトレーラを外して 1 本につなぐ。
- **ラベル**: 旧 `AccountLabelLatest` の行をそのまま stg へ流し (false 行と評価不能行の reason などは旧 DB 側で捨てる)、新 DB 側で組み立てる。旧 DB 側で `array_agg` の集計をすると、数億行のソートが旧ボリュームの一時ファイルに載るため。
- **`versionNo`**: ラベルごとの distinct な `ruleVersion` を、数字とドットだけの版は数値の並び、それ以外は C 照合順で 1 から振る。`LabelDefinition.currentRuleVersion` が行に現れない場合も振る。
- **`evaluatedAt`**: アカウントの全ラベル行の `labeledAt` の最大値。`rev` は 0 から始める。
- **`LabelDefinition.id`**: (定義の有無、`createdAt`、`key`) の順に 1 から採番する。定義が無いのに `AccountLabelChange` などが参照している id は、`retired:<旧 id>` の廃止済み行 (`retiredAt` 付き) として保持する。巨大表 (AccountLabelLatest、ACL) だけに現れる未登録の id は、NOT NULL 違反で投入が止まる。
- **work item**: 未処理・実行中・dead だけを `AnalysisWorkItem` に残し、残す行を `createdAt` 順に int id へ変換する。完了済みの論理キーは、旧 DB の基準時刻から 30 日分を `AnalysisWorkItemDone` へ入れる。`workItemId`、`attemptCount`、`createdAt`、`completedAt` (旧 `updatedAt`) を旧 DB の行から写し、`workItemId` は他の表と同じ変換表を通した int id にする。`account_relabel` は再 arm できる kind のため台帳に入れない。台帳の行と、完了済みで参照だけが残る id (`AnalysisRun.workItemId`、`LabelMetricSnapshot.triggerWorkItemId`) には、残す行の後ろの int id を与える (外部キーなし)。`AnalysisWorkItem` と `AnalysisRun` の identity は、取り込んだ最大の id まで `setval` する。
- **Tweet**: 参照のない 4 列を外し、空配列を NULL にし、`foreignVideoSourceCount` と `hasMedia` の NULL を、旧 backfill と同じ判定 (`FV_SINCE`、`HM_SINCE` 以降の `collectedAt`) で `0` と `false` に確定する。方式 (HASH か RANGE) は、`tweet-hash.sql` と `tweet-range.sql` のどちらを適用したかで自動的に決まる。振り分けの計算が PostgreSQL のものと一致しているかは、attach 時のパーティション制約の検証が全行で確認する。
- **ACL の集計表、AccountSummaryLatest**: トリガーを止めたうえで、旧 DB の値を写す。`LabeledAccountCounter` も旧 DB の値を写す。
- **AccountLabelChange**: `id` は新しい identity が `changedAt` 順に採番する (BRIN が効くよう物理順を時刻順にする)。`sourceLabelId` は旧スキーマで削除済みのため NULL。旧データには `changeType = 'updated'` の行が多く、新 baseline の enum (`added`、`removed`、`unevaluable`) には無い。`KEEP_UPDATED=false` (既定) はその行を捨て、`true` は baseline の enum に `updated` を足した場合だけ使える (足していないと load.sh が最初に止まる)。

## 検証ゲート

| ゲート | 内容 |
| --- | --- |
| テーブルの件数とハッシュ | 旧 DB 側は `transform/*.sql` の出力、新 DB 側は同じ列を投入後の表から取り、`hashtext(キー) % 256` のシャードごとに件数と内容ハッシュを比べる。列の対応表は `transform/*.sql` のヘッダの `columns` |
| ラベルの再構築 | 新側の `AccountLabelState` と `AccountActiveLabel` から (アカウント, ラベル, ruleVersion, 値, 評価不能) を再構築し、旧 `AccountLabelLatest` と比べる (false 行と評価不能行の reason、confidence は含めない)。件数、シャード別ハッシュ、ラベル × ruleVersion の true 件数と評価不能件数、coverage、先頭 1000 アカウントの乾式の差分 |
| 完了台帳 | `AnalysisWorkItemDone` が旧 DB の完了済みの行を `workItemId` (変換表を通した新 id)、`attemptCount`、`createdAt`、`completedAt` まで過不足なく持ち、`account_relabel` を含まず、キュー表と論理キーも id も重ならない。`AnalysisWorkItem`、`AnalysisRun`、`AccountLabelChange` の identity が取り込んだ最大の id 以上 |
| 不変条件 | `AccountCrawlState` が `Account` と同数で 1 対 1 (欠落も孤児も無く、`lastCrawledAt` は NULL なし)、評価不能なのに true の行が無い (旧データにある評価不能かつ true の行は、変換で評価不能 (false) に揃える)、`versionNo` が 1 から連続、`evaluatedAt` の一致、未変換のラベル id が 0、`labelDefinitionId` 列がすべて smallint |
| 復元 | 外した制約、インデックス、FK がすべて戻り、無効なインデックスが無い |
| EXPLAIN | 直近 20 件、blocker 候補、backfill 候補、stale scan が Seq Scan を使わず、想定のインデックスを使う |
| サイズ | `pg_database_size` が 90GiB 以下 (シャード実行は、空の baseline からの増分を拡大率倍して判定) |

relabeler の実際の dry-run は、このツールの範囲に含めない。代わりに、先頭 1,000 アカウントについて、再構築した行が旧 DB の行と食い違う件数 (書き込み予定の差分に相当) が 0 であることを確認する。

## 切り替え時間の見積もり

- 1% シャード (`rehearsal.sh`) は、アカウント単位で旧 DB の表を散在して読むため、旧 DB の読み出しが遅い側 (悲観側) の速度になる。そのまま 100 倍した値を切り替え時間とみなさない。
- 切り替え本番は、`big: ctid` のとおり表の物理順に逐次読み出す。`seqslice.sh` が、その経路を Tweet と AccountLabelLatest の小さなスライスで測る (旧 DB の素の逐次読み出し、変換 SELECT の受信、振り分け、新 DB への COPY FREEZE、インデックス作成とラベルの集約)。
- 全量の見積もりは、`seqslice.sh` の 1 GiB あたりの秒数に、旧 DB の表のサイズを掛けて足す。前提 (旧ホストが負荷のある状態か、サービスを止めた状態か、読み出しが散在か逐次か) を数値の横に書く。
- 旧ホストの IO 圧力 (`/proc/pressure/io` の full avg60) が `IO_PSI_LIMIT` (既定 60) を超えたら中断する。
- 最終的な切り替え時間は、切り替え時に、サービスを止めた旧ホストと新 DB のボリュームで `fio.sh` を測り直して見積もり直す。リハーサルの値は、負荷のある旧ホストでの目安である。

## 自己テスト

旧スキーマの空の DB (本番の `pg_dump --schema-only`) に `testdata/seed-old.sql` を入れ、`OLD_PSQL` をその DB に向けて `load.sh` と `verify.sh` を実行する。検証が壊れた新 DB に対して FAIL することも、`AccountLabelState` の値や Tweet の行を書き換えて確認している。
