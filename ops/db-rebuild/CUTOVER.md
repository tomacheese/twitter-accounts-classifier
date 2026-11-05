# 本番切り替え手順書 (DB 作り直し)

旧 DB (text ID、`AccountLabelLatest`) から新 DB (bigint ID、疎なラベル保存、Tweet のパーティション) への一括切り替えの手順書。手順はすべて `ops/db-rebuild/cutover/` のスクリプトにしてあり、この文書は実行順、期待される出力、停止条件を定める。

**この文書とスクリプトは、本番では未実行である。** 本番の書き込み、新 DB の投入、切り替え、ロールバックは、いずれもユーザーの明示的な承認を得てから実行する。`master` へのマージも、ユーザーが明示的に指示するまで行わない。

## 1. 流れ

```text
A. 事前 (停止枠の外)   承認 → master の取り込みと Task 10 → イメージのビルド → 設定 → 新 DB の初期化 → preflight
B. 停止枠 (4 時間)     freeze → run-migration → switch (roles → steady → gate → finish → apps) → postcheck
C. 観察               1 時間後、24 時間後 (blocker 起動)、72 時間後
D. 事後               master へのマージ → 載せ替え → watchtower の再開 → 旧 DB の保持と退避
```

スクリプトは本番ホスト (Nuts) の上で実行する。スクリプトの中では ssh を使わない。Pine からは `ssh Nuts` で入って実行する。

## 2. 設計上の判断 (読んでから実行する)

### 2.1 watchtower の自動デプロイ

master にマージすると、CI がイメージを公開し、watchtower が本番を更新する。新コードは旧 DB と互換性がないため、切り替えの前に master へマージしてはならない。さらに、切り替えの最中と成功後も、次の理由で watchtower を止めたままにする。

- 切り替えで動かすイメージは `feat/db-rebuild` のローカルビルドで、マージ後に CI が公開するイメージとはダイジェストが異なる。そのまま watchtower を再開すると、全サービスが予告なく再作成される。
- 再開の手順は 10 章で、先に載せ替えて稼働中のイメージを watchtower が見るイメージと一致させてから再開する。

`preflight.sh --stop-watchtower` が、watchtower を停止して自動再起動も無効にし、止まったことを確認する (名前かイメージに `watchtower` を含むコンテナをすべて対象にする)。止まっていなければ、`freeze.sh`、`switch.sh apps`、`rollback.sh` は先へ進まない。切り替え後の compose override は、サービスに watchtower の除外ラベル (`com.centurylinklabs.watchtower.enable=false`) も付ける。

### 2.2 イメージは CI から得られないため、ローカルでビルドする

共通の CI (`reusable-docker.yml`) は、マージされたときにしかイメージを push しない。マージ前の PR のビルドは公開されない。そのため切り替えで使うイメージは `build-images.sh` でビルドし、コミットの SHA で固定したタグ (`tac-rebuild/<名前>:<SHA 12 桁>`) を付ける。`latest` は使えない。`preflight.sh` は、タグが固定されていること、ホストにあること、イメージのリビジョンのラベルがチェックアウトの HEAD と一致することを確認する。

本番ホストでのビルドは、RAM を共有する他コンテナに響くため、Pine でビルドして `--ship-to Nuts` で送ることを勧める。アーキテクチャは `BUILD_PLATFORM` (既定 `linux/amd64`) で本番ホストに合わせる。

旧コードの現行イメージは、`preflight.sh` が稼働中のコンテナから特定し、`tac-rollback/<サービス>:pre-rebuild` というローカルのタグで固定する (イメージの掃除で消えないようにするため)。ロールバックはこのタグを使う。

### 2.3 アプリ用ロールと管理者ロールを分ける

`initdb` のブートストラップのユーザーは降格できない (`The bootstrap superuser must have the SUPERUSER attribute`)。`initdb.sh` の既定の `crawler` をブートストラップにすると、アプリが常にスーパーユーザーで接続し、`AccountLabelState` と `AccountActiveLabel` への直接 DML の REVOKE (Task 1) が効かない。そのため新 DB は次の構成にする。

| ロール | 属性 | 用途 |
| --- | --- | --- |
| `tac_owner` (`NEW_DB_USER`) | ブートストラップのスーパーユーザー。全オブジェクトの所有者 | initdb、baseline、load.sh、verify.sh、switch-to-steady.sh、権限の同期。アプリは使わない |
| `crawler` (`APP_DB_ROLE`) | `NOSUPERUSER`、所有者でない。パスワードは `NEW_APP_DB_PASSWORD` | crawler、relabeler、blocker、storage-guard。2 つの表への直接 DML は REVOKE、`set_label_result` だけ実行可 |
| `viewer`、`analyzer` | 既存の専用ロール | viewer、analyzer |

`crawler`、`viewer`、`analyzer` の 3 つは、`scripts/db/run-migration-and-sync-grants.sh` (マージ後の compose の `migrate` サービスと同じスクリプト) が所有者の接続で作成と同期をする。本番の `.env` では、`DB_OWNER_PASSWORD` が `NEW_DB_PASSWORD`、`CRAWLER_DB_PASSWORD` が `NEW_APP_DB_PASSWORD` と同じ値になる (どちらも URL の予約文字 `@ : / # ? %` を含めない。compose が接続 URL に埋め込むため)。`preflight.sh` が、使える文字と `.env` との一致を確認する。

`switch.sh roles` が、この同期スクリプトの実行、`functions.sql` の権限の節の再適用、REVOKE の確認 (権限の照会と、`crawler` としての実際の拒否) までを行う。ロール同期は、crawler のイメージから一回限りのコンテナを新 DB コンテナのネットワーク名前空間で動かし、ループバック経由で所有者ロールとして接続する (パスワードは 0600 の一時ファイルの `PGPASSWORD` で渡し、終了時に削除する)。

`crawler` の `INSERT`、`UPDATE`、`DELETE`、`TRUNCATE` の REVOKE は、`AccountLabelState` と `AccountActiveLabel` の表そのものに付く権限である。これらの表を作り直す migration (`DROP TABLE` と `CREATE TABLE`) を流した後は、`functions.sql` の `-- 権限` の節を所有者ロールで再実行する。`postcheck.sh` が、この REVOKE が効いていることを毎回確認する。

### 2.4 アプリの entrypoint と compose の `migrate` サービス

`entrypoint.sh` は `prisma migrate deploy` も権限同期も実行しなくなった (seed とクロールのループだけ)。スキーマは `prisma/baseline` から作る。マージ後の `compose.yaml` では、`migrate` サービスが `prisma/baseline/apply.sh` (適用済みなら何もしない) と権限同期を、所有者ロール (`tac_owner`) で実行する。

切り替えは `migrate` サービスを使わない。新 DB のスキーマは `run-migration.sh --init-only` が baseline から作り、ロールの作成と権限同期は `switch.sh roles` が、crawler のイメージから所有者の接続で実行する。**crawler のイメージは、この同期スクリプトを含むコミット (Task 10 のマージ後) からビルドすること。**

今後のスキーマ変更は、アプリ用ロールからは実行できない。所有者ロール (`tac_owner`) の接続で、一回限りのコンテナから実行する。

### 2.5 新 DB への接続

新 DB は別の compose プロジェクト (`tac-new-db`) のコンテナである。`docker network connect` で、アプリと同じネットワークへ繋ぎ、`DATABASE_URL` のホストをコンテナ名 (`tac-new-postgres`) にする。`switch-to-steady.sh` が新 DB のコンテナを作り直すと接続が外れるため、`switch.sh` が作り直しの後に繋ぎ直す。新 DB のコンテナを自分で作り直した場合も、`docker network connect <ネットワーク> tac-new-postgres` をやり直す。

`initdb` が作る `pg_hba.conf` は、ローカルとループバックしか許可しない。そのままではアプリのコンテナが接続できないため、`switch.sh roles` が `host <データベース名> crawler,viewer,analyzer samenet scram-sha-256` の行を足して設定を再読み込みする (新 DB が繋がっているサブネットの中で、アプリが使う 3 つのロールだけを、パスワード認証で許可する。所有者ロールはネットワークから接続できない。行はデータディレクトリにあり、ベースバックアップにも入る)。

各サービスの新しい `DATABASE_URL` は、現行の compose の値 (`docker compose config` の出力) のホスト、データベース名、`crawler` のパスワードだけを置き換えて作る。サービスごとのロールは、crawler、relabeler、blocker、storage-guard が `crawler`、viewer が `viewer`、analyzer が `analyzer` である。接続数の上限などのクエリ文字列と、viewer と analyzer の専用ロールは、そのまま引き継ぐ。

#### 決定: 新 DB は別プロジェクトのまま、アプリ側の接続先だけを切り替える

| 案 | 内容 | 判断 |
| --- | --- | --- |
| 1 (採用) | 新 DB (`tac-new-db` プロジェクトの `tac-new-postgres`) を、アプリのネットワークへ `docker network connect` で繋ぎ、サービスの `DATABASE_URL` のホストをコンテナ名にした override で起動する | 旧 postgres のコンテナ、ボリューム、compose の定義に一切触れない。ロールバックは、override をやめて、控えの compose と旧イメージで同じサービスを作り直すだけ |
| 2 | 旧 postgres を止めて、新 DB に `postgres` というネットワークエイリアスを付ける | 旧 postgres が動いている間は Docker の DNS が両方を返す恐れがある。旧 compose のパスワードも変わるため、`DATABASE_URL` の差し替えが結局要る |
| 3 | 新 DB をアプリの compose の `postgres` サービスに載せる (データディレクトリの差し替え) | 新 DB の設定 (チューニング、WAL アーカイブ、ベースバックアップ、`DB_PROFILE`) は `compose.new-db.yaml` にあり、`compose.yaml` の `postgres` には無い。また `compose.yaml` の `postgres` は所有者ロール名が変わっており、旧データディレクトリでは起動しないため、ロールバックが compose の差し替えになる |

案 1 のロールバックは `rollback.sh` が行う。手で行う場合の等価なコマンドは次のとおり。

```bash
# 1. 新スタックを止める (blocker は起動していないこと)
ops/db-rebuild/cutover/compose.sh stop storage-guard relabeler crawler analyzer viewer
# 2. 旧 DB を書き込み可能に戻す (凍結の逆。old-acl.tsv の GRANT と ALTER DATABASE ... RESET default_transaction_read_only)
# 3. 控えの compose (STATE_DIR/pinned-compose) と旧イメージ (tac-rollback/*:pre-rebuild) で、旧 DATABASE_URL のまま起動する
docker compose --project-name <COMPOSE_PROJECT> --project-directory <PROD_COMPOSE_DIR> \
  --env-file <STATE_DIR>/pinned-compose/env -f <STATE_DIR>/pinned-compose/compose.yaml \
  -f <STATE_DIR>/compose.old.yaml up -d --no-deps --no-build --pull never crawler storage-guard analyzer relabeler viewer
```

2 と 3 は `rollback.sh` を使うこと (権限の復元、差の確認、記録の退避を含むため)。

#### 控えの compose

本番ホストの `compose.yaml` は、切り替えの途中で `git pull` などで master のものに変わることがある。マージ後の `postgres` サービスは、旧データディレクトリでは起動しない (所有者ロールが変わった)。そのため `preflight.sh` が、最初の実行で `compose.yaml` と `.env` を `STATE_DIR/pinned-compose/` へ複製し (チェックアウトのコミットも `commit` に記録する)、切り替え、`compose.sh`、`rollback.sh` はこの控えで compose を読む。控えは `--env-file` で `.env` も固定する。現行のファイルが控えと違うと、`preflight.sh` が警告する。master のマージ後の載せ替え (`reenable-watchtower.sh`) だけは、現行の (マージ済みの) `compose.yaml` を使う。

### 2.6 compose の操作は必ず override を付ける

切り替え後のサービスは、`$STATE_DIR/compose.new.yaml` (イメージの固定と `DATABASE_URL`) を重ねて起動している。override を付けずに `docker compose up` を実行すると、`DATABASE_URL` が旧 DB に戻り、旧 postgres と `migrate` サービスまで起動する。操作は `ops/db-rebuild/cutover/compose.sh` を使う (`up` と `run` は `--no-deps` を要求する)。

### 2.7 停止と起動

- サービスの entrypoint は sh のループで SIGTERM に反応しないため、`docker stop` は待ち時間 (`STOP_TIMEOUT`、既定 30 秒) の後の SIGKILL になる。そのため blocker は、実行中の run が無いことを確かめてから止める (`BLOCKER_IDLE_WAIT_SECS` まで待つ)。
- 起動順は、storage-guard、analyzer、relabeler、crawler、viewer。relabeler は `StorageCapacityState` が無い、または古いと fail-closed で止まるため、`switch.sh apps` は storage-guard の最初の計測が新 DB に書かれる (`STORAGE_METRICS_WAIT_SECS`、既定 180 秒) のを待ってから relabeler を起動する。blocker は起動しない。

## 3. スクリプト

| スクリプト | 内容 | 実行する時期 |
| --- | --- | --- |
| `build-images.sh` | 4 つのイメージを `feat/db-rebuild` からビルドして SHA のタグで固定し、`--ship-to` で本番ホストへ送る | A |
| `run-migration.sh --init-only` | 新 DB の initdb、起動 (bulk)、baseline の適用 | A (前日まで) |
| `preflight.sh` | 切り替え前の確認。`--stop-watchtower` で watchtower を止める | A (前日夜、停止枠の直前にもう一度) |
| `freeze.sh` | 停止枠の開始。blocker を最初に止めて旧 DB を読み取り専用にし、件数と最大 ID を記録する。`--check` は凍結後に旧 DB が変わっていないことの確認 | B |
| `run-migration.sh` | `load.sh` と `verify.sh` を、完了まで実行する (時間は目安であり、超えても止めない) | B |
| `switch.sh` | `roles`、`steady`、`gate`、`finish`、`apps`、`blocker`。既定の `all` は blocker を含まない | B、C (24 時間後に `blocker`) |
| `postcheck.sh` | 切り替え後の確認 | B 直後、C |
| `rollback.sh` | 旧 DB と旧イメージへ戻す | 判断基準を満たしたとき |
| `reenable-watchtower.sh` | master のイメージへの載せ替えと、watchtower の再開 | D |
| `compose.sh` | override を付けた compose 操作 | 切り替え後 |
| `selftest.sh` | scratch のコンテナだけで通しの動作を確認する | 手順書の変更時 |

全スクリプトが `--dry-run` を受け付ける。読み取りは実行し、変更を伴うコマンドは表示するだけにする。スクリプトは冪等で、途中で止まった場合は同じコマンドを再実行する (進捗は `STATE_DIR/steps/` の印で管理する)。

## 4. 設定 (`cutover.env`)

`cutover.env.example` を `cutover.env` にコピーして埋める (`.gitignore` 済み、`chmod 600`)。**ユーザーが決める値**と、**本番ホストで確認する値**を区別して、実行前に埋める。

| 項目 | 内容 | 決める人 |
| --- | --- | --- |
| `PROD_COMPOSE_DIR`、`PROD_COMPOSE_FILES`、`COMPOSE_PROJECT` | 本番の compose の場所とプロジェクト名 | 本番ホストで確認 |
| `OLD_DB_CONTAINER`、`OLD_DB_NAME`、`OLD_DB_USER` | 旧 DB のコンテナ名、データベース名、ロール (crawler の `DATABASE_URL` と一致が必須) | 本番ホストで確認 |
| `WATCHTOWER_CONTAINER` | watchtower のコンテナ名 | 本番ホストで確認 |
| `NEW_DB_PASSWORD`、`NEW_APP_DB_PASSWORD` | 管理者ロールとアプリ用ロールの password。新規に決める | ユーザー |
| `NEW_DB_DATA_HOST_PATH` ほか 2 つ | 新 DB のデータ、WAL アーカイブ、ベースバックアップの置き場 | ユーザー |
| `TWEET_VARIANT` | Task 9 のリハーサルで決まった Tweet のパーティション方式 (`hash` か `range`) | Task 9 の結果 |
| `NEW_IMAGE_CRAWLER`、`_VIEWER`、`_BLOCKER`、`_ANALYZER` | `build-images.sh` の出力 | オーケストレーター |
| `EST_PREPARE_SECS`、`EST_LOAD_SECS`、`EST_RESTORE_SECS`、`EST_VERIFY_SECS`、`EST_STEADY_SECS` | リハーサルの外挿値と fio を踏まえた見積もり (秒) | Task 9 の結果 |
| `KEEP_UPDATED`、`ENUM_UPDATED` | 旧データの `changeType='updated'` を残すか | ユーザー (Task 9 の未決事項) |
| `WINDOW_MINUTES`、`BUDGET_PERCENT` | 停止枠 (既定 240 分) と、警告を出す目安の割合 (既定 70)。工程は止めない | ユーザー |

## 5. 時間の目安

停止枠は 240 分で、目安は 70% の 168 分である。経過時間は `freeze.sh` の開始時刻から数える。

**時間は警告にしか使わない。** 経過時間と残りの見積もり (`EST_*`) の合計が目安を超えると、`run-migration.sh` の各工程の前と `switch.sh` の前に警告を出すが、そのまま続ける。停止した後に時間を理由に中断すると、停止時間が無駄になって、もう一度停止が要るためである。移行は、時間がかかっても完了まで進める。

| 工程 | 目安 | 扱い |
| --- | --- | --- |
| freeze (blocker の停止と確認、全サービスの停止、旧 DB の凍結、件数の記録) | 10〜15 分 | 30 分を超えるなら原因を調べる。blocker が実行中の run を終えない場合は先へ進まない |
| run-migration (prepare、load、restore、verify) | `EST_*` の合計 | 目安を超えても止めない。各工程の前に、経過時間と残りの見積もりを表示する |
| switch (roles、steady、gate、finish、apps) | `EST_STEADY_SECS` + 約 10 分 | 目安を超えても止めない |
| postcheck | 約 5 分 | 失敗したらロールバックの判断基準へ |

**切り替えの前に止めるのは、正しさの失敗だけである。**

- 検証ゲートの FAIL (件数、ハッシュ、ラベルの不一致、孤児、外部キーの失敗)
- `preflight.sh` の安全確認の失敗 (ディスク容量、watchtower が止まっていない、blocker の実行中の呼び出し)
- 旧 DB の読み取り専用の凍結が失われたこと (`freeze.sh --check-readonly` が、各工程の前に確かめる)
- 工程そのものの失敗

IO 圧力による中断は、稼働中の本番 DB を読むリハーサルだけで使う (`OLD_GUARD_SSH`)。サービスを止めた切り替えの間は使わない。`run-migration.sh` は IO 圧力を `STATE_DIR/psi.log` に記録するだけで、止めない。

止めた場合、旧 DB は読み取り専用のままで、`DATABASE_URL` は変わっていない。原因を直して `run-migration.sh --from <工程>` で再開するか、`rollback.sh --reason abort-before-cutover` で停止前の状態へ戻す。

## 6. マスターチェックリスト

担当は、**ユーザー** (承認と判断) と **オーケストレーター** (コマンドの実行) に分ける。コマンドは、リポジトリのルート (`feat/db-rebuild` のチェックアウト) から実行する。`cutover/` の接頭辞は `ops/db-rebuild/cutover/` を指す。

### A. 事前 (停止枠の外)

| # | 担当 | 手順とコマンド | 期待される出力 | 停止条件 |
| --- | --- | --- | --- | --- |
| A1 | ユーザー | 停止枠 (4 時間) の日時、同居する他プロジェクトのコンテナの扱い、watchtower が他プロジェクトも担当していないか、未決事項 (旧ボリュームの保持日数、`pg_dump -Fc` の保管先、WAL アーカイブの有無、`KEEP_UPDATED`) を決め、切り替えを承認する | 承認の記録 | 承認が無ければ何も実行しない |
| A2 | オーケストレーター | 最新の `master` を `feat/db-rebuild` へ取り込み、Task 10 の検証 (各パッケージの `pnpm check` と `pnpm format`、等価性テスト) を再実行する | すべて成功 | 失敗したら原因を究明するまで進まない |
| A3 | オーケストレーター | 本 PR と Task 9 の PR を `feat/db-rebuild` へ取り込んだ状態で `cutover/build-images.sh --ship-to Nuts` | 末尾に `NEW_IMAGE_*=tac-rebuild/...:<SHA>` の 4 行 | ワーキングツリーが汚れていると中断する |
| A4 | オーケストレーター | Nuts で `cp cutover/cutover.env.example cutover/cutover.env`、4 章の値を埋め、`chmod 600`。本番の `.env` へ `DB_OWNER_PASSWORD` と `CRAWLER_DB_PASSWORD` を追記する (値は `NEW_DB_PASSWORD` と `NEW_APP_DB_PASSWORD` と同じ。旧 compose はこの 2 つを参照しないため、追記しても稼働中のサービスには影響しない) | | 「要確認」の値が空のまま進まない。パスワードに `@ : / # ? %` を含めない |
| A5 | オーケストレーター | `cutover/run-migration.sh --init-only` | `new DB is initialized with the baseline` (`data_checksums=on`、`wal_level=minimal`) | initdb が非空のディレクトリを拒否したら、原因を確認してから空にする |
| A6 | オーケストレーター | `cutover/preflight.sh --stop-watchtower` (前日夜。fio も実測する) | `preflight: N PASS, N WARN, 0 FAIL` と `preflight passed`。fio の結果が `STATE_DIR/fio.preflight` に残る。`STATE_DIR/pinned-compose/` に、ロールバック用の旧 `compose.yaml` と `.env` の控えができる | FAIL があれば先へ進まない。WARN は内容を読んで判断する |
| A7 | オーケストレーター | Task 9 のリハーサルの外挿値と A6 の fio の結果から、`cutover.env` の `EST_*` を更新する | | fio がリハーサルの想定を下回る場合は、ユーザーに報告して停止枠を再検討する |
| A8 | オーケストレーター | 停止枠の直前に `cutover/preflight.sh` をもう一度実行する (イメージ、ディスク、旧 DB の状態の再確認) | `preflight passed` | FAIL があれば停止枠を始めない |
| A9 | ユーザー | 停止枠の開始を承認する | | |

### B. 停止枠

| # | 担当 | 手順とコマンド | 期待される出力 | 停止条件 |
| --- | --- | --- | --- | --- |
| B1 | オーケストレーター | `cutover/freeze.sh --yes` (A9 の承認の後) | `blocker is stopped; unresolved outbox=0, running runs=0`、`old DB rejects writes: cannot execute CREATE TABLE in a read-only transaction`、`freeze complete` | blocker に未解決の outbox がある場合は 9.1。旧 DB が書き込みを受け付ける場合は先へ進まない |
| B2 | オーケストレーター | `cutover/run-migration.sh` | 各工程の `phase ... finished`、`migration and verification gates passed after Ns of the window (reference 10080s)`。目安を超えると `WARN` が出るが続く | `the verification gates did not pass` は原因を究明して `--from verify` などで再開する。直せなければロールバック。`the read-only freeze was lost` は旧 DB が書き込みを受け付けているため、続けずに原因を調べる (5 章) |
| B3 | オーケストレーター | `cutover/switch.sh --yes` (roles、steady、gate、finish、apps) | `role self-check` がすべて `ok`、`table counts are identical before and after the restart`、各サービスの `is up`、`services are on the new DB` | どの工程も失敗したらそこで止まる。`apps` より前の失敗は、アプリが止まったままで旧 DB も無傷。判断はロールバックか原因の修正 |
| B4 | オーケストレーター | `cutover/postcheck.sh` | `postcheck: N PASS, N WARN, 0 FAIL` | FAIL があれば 7 章の判断基準へ |
| B5 | ユーザー | postcheck の結果と、窓の残り時間を確認して、切り替えの成功を宣言する | | |

### C. 観察

| # | 担当 | 手順とコマンド | 期待される出力 | 停止条件 |
| --- | --- | --- | --- | --- |
| C1 | オーケストレーター | 1 時間後に `cutover/postcheck.sh` | FAIL なし | **切り替え後 1 時間以内にエラーが継続したら `rollback.sh --reason errors-1h`** |
| C2 | オーケストレーター | 24 時間後に `cutover/postcheck.sh --full-orphans` (ピークを避ける) | FAIL なし | |
| C3 | ユーザー | 24 時間の観察結果を確認し、blocker の起動を承認する | | |
| C4 | オーケストレーター | `cutover/switch.sh blocker --confirm-observed-24h` | `blocker started on the new DB` | 24 時間未満、postcheck の失敗、新 DB に未解決の outbox がある場合は拒否される (起動しない) |
| C5 | オーケストレーター | 72 時間後に `cutover/postcheck.sh`。relabeler と crawler のエラー率が切り替え前 1 週間を上回っていないことを GlitchTip で確認する | FAIL なし | 上回る場合は原因を調べる (blocker 起動後は自動のロールバックはできない。9.4) |

### D. 事後

| # | 担当 | 手順 | 期待される結果 |
| --- | --- | --- | --- |
| D1 | ユーザー | 72 時間後の確認を終え、`master` へのマージを明示的に指示する | |
| D2 | オーケストレーター | 10 章の手順で `master` へマージし、イメージを載せ替えて watchtower を再開する | `reenable-watchtower.sh check` が全件一致 |
| D3 | オーケストレーター | 新 DB の `pg_dump -Fc` を `/mnt/hdd` へ退避する (保管先はユーザーが決める)。旧 DB は 1 週間保持する | |
| D4 | ユーザー | 1 週間後に、旧 DB のコンテナとボリュームの撤去を指示する | |

## 7. ロールバック

### 判断基準

- 検証ゲートの再実行が失敗した場合 (`switch.sh gate` が失敗した場合を含む)
- 切り替え後 1 時間以内にエラーが継続した場合
- 切り替え前の中断 (検証ゲートの失敗、凍結の喪失、判断による中止。時間の超過だけでは中断しない)

### 実行

```bash
ops/db-rebuild/cutover/rollback.sh --reason <gate-failed|errors-1h|abort-before-cutover|manual>
```

`rollback.sh` が行うこと: watchtower が止まっていることの確認、新スタックの停止 (blocker を含め、動いていないことの確認)、旧 DB の凍結前との差の確認、書き込み権限の復元と `default_transaction_read_only` の解除、旧イメージ (`tac-rollback/*:pre-rebuild`) と旧 `DATABASE_URL` でのサービスの起動 (blocker を除く)、停止中の blocker コンテナのログの退避と削除、他プロジェクトのコンテナが変わっていないことの確認、記録の退避。

守ること:

- **旧 blocker を再起動しない。** 古い outbox の状態を再実行するため。`rollback.sh` は blocker を起動せず、停止していることを確認する。
- **watchtower は止めたままにする。**
- 切り替え後に新 DB へ書かれたデータは旧 DB に無い。切り替えから 1 時間を過ぎると、`--force-late` を付けないと拒否される。付けるのは、ユーザーが明示的に承認したときだけ。
- blocker が新 DB で起動した後は、自動のロールバックを拒否する (blocker の outbox の記録が新 DB にしか無いため)。判断は 9.4。
- ロールバック後、新 DB のコンテナは調査のために残る。もう一度試す前に、破棄する (9.3)。

## 8. 停止条件のまとめ

| 状況 | 扱い |
| --- | --- |
| watchtower が止まっていない、または止まったことを確認できない | `freeze.sh`、`switch.sh apps` に進まない |
| ユーザーの承認が無い | 何も実行しない |
| `preflight.sh` に FAIL がある | 停止枠を始めない |
| 時間の目安の超過 (経過 + 残りの見積もりが 168 分を超える) | **止めない。** 警告を記録して続ける (5 章) |
| 検証ゲートが通らない | 切り替えない。原因を究明して、直して再開する。直せなければロールバック |
| 旧 DB の読み取り専用の凍結が失われた | 移行を続けない。原因を調べ、必要なら `freeze.sh` で凍結し直す |
| blocker に未解決の outbox がある | 9.1 |
| `switch.sh roles` の自己点検が失敗 | `apps` に進まない |
| 新 DB が予期せず再起動した (crash recovery) | 破棄して作り直す (9.3)。復旧を試みない |
| 切り替え後 1 時間以内にエラーが継続 | ロールバック |
| blocker の起動が 24 時間未満 | 起動できない (スクリプトが拒否する) |

## 9. 異常時の手順

### 9.1 blocker に未解決の outbox がある (`freeze.sh` が拒否した)

`BlockOutboxEntry` の `pending_remote` と `remote_succeeded` は、外部への block 呼び出しが済んだか不明な行である。旧 DB を移行して blocker を新 DB で起動すると、これらを再実行または照合する。先へ進んではならない。

1. `freeze.sh` が表示した行 (`BlockOutboxEntry`) を確認する。blocker は停止済みで、ほかのサービスは動いたまま。
2. 判断はユーザーが行う。(a) 旧 blocker を一時的に起動して照合を終わらせる。通常運用と同じ動作で、凍結の前なので旧 DB への書き込みは許されるが、外部への block 呼び出しを伴い、停止枠を使う。完了後に `freeze.sh` を再実行する。(b) 該当の行を個別に調べて扱いを決める。どちらも、この手順書では自動化しない。
3. 解決するまで、`freeze.sh` は先へ進まない。旧 DB は凍結されていないため、サービスを戻す場合は `rollback.sh --reason abort-before-cutover` を使う。

### 9.2 freeze の途中で失敗した

`freeze.sh` を再実行する。停止済みのサービスは飛ばし、ACL の控えは最初の 1 回だけ書く。旧 DB が既に読み取り専用の場合も、そのまま続く。続けられない場合は `rollback.sh --reason abort-before-cutover`。

### 9.3 新 DB を破棄して作り直す

投入中のクラッシュは復旧せず、破棄して作り直す (旧 DB は無傷)。

```bash
docker compose -f ops/db-rebuild/compose.new-db.yaml down   # DB_PROFILE=bulk を付ける
# データ、WAL アーカイブ、ベースバックアップの 3 つのディレクトリを、docker run --rm --user root で空にする
ops/db-rebuild/cutover/run-migration.sh --init-only
```

その後、`run-migration.sh` を `--from prepare` で再実行する (`STATE_DIR/steps/migrate-*` の印と、停止枠の記録 (`freeze-counts.tsv`、`old-acl.tsv`) は、`rollback.sh` が履歴へ移す。`--from <工程>` は、その工程以降の完了印と `verified` を消して、その工程からやり直す)。

### 9.4 blocker 起動後に問題が出た

blocker の outbox の状態は新 DB にしか無い。旧 DB へ戻すと、blocker が実行した block が旧 DB に無く、再実行の恐れがある。自動のロールバックは拒否される。blocker を止めて (`compose.sh stop blocker`)、ユーザーと対応を決める。

### 9.5 ロールバック後の blocker

ロールバック後も blocker は停止のままで、コンテナも削除される (新 DB の設定のまま残ると、誤って起動したときにどちらの DB を指すか分からないため。ログは `STATE_DIR/history/` に残る)。起動は別の判断で、ユーザーが明示的に指示してから、旧 DB の outbox に未解決が無いことを確認して行う。

## 10. master へのマージと watchtower の再開

**切り替えが成功し (72 時間の観察を終え)、ユーザーが明示的に指示してから行う。** それまで watchtower は止めたままにする。

1. **事前確認**: `postcheck.sh` が FAIL なし。blocker が起動済み。新 DB のベースバックアップが取れている。
2. **マージ**: `feat/db-rebuild` を `master` へ、リポジトリの通常のマージ方式でマージする。この時点で CI が、4 つのイメージを `latest` とバージョンタグで公開する。watchtower は止まっているため、本番は更新されない。
3. **イメージの公開を待つ**: Docker ワークフローが、4 つのイメージすべてで成功するまで待つ。
4. **compose の更新 (別 PR)**: 本番の compose が新 DB を指すようにする (新 DB のサービス定義、`DATABASE_URL` のホスト、旧 `postgres` と `migrate` の扱い。マージ後の `compose.yaml` の `postgres` と `migrate` は旧データディレクトリでは動かないため、`docker compose up` は実行しない)。この PR の範囲外。それまでは、`reenable-watchtower.sh adopt` が、`DATABASE_URL` を新 DB のまま、イメージだけを compose の参照へ載せ替える。
5. **差分の確認**: `ops/db-rebuild/cutover/reenable-watchtower.sh check`。compose が指すイメージを pull し、稼働中のコンテナのイメージと比べる。ローカルビルドと CI のビルドは別のイメージなので、通常は全サービスが `WOULD redeploy` になる。
6. **載せ替え**: `ops/db-rebuild/cutover/reenable-watchtower.sh adopt`。差のあるサービスを 1 つずつ再作成する。blocker は、起動済みで outbox に未解決が無いときだけ、最後に載せ替える (実行中の run があれば拒否される。周期の合間に再実行する)。載せ替えたコンテナは、watchtower の除外ラベルが外れて watchtower の管理に戻る。
7. **再開**: `ops/db-rebuild/cutover/reenable-watchtower.sh check` が全件一致になってから、`reenable-watchtower.sh enable`。再開の前に、watchtower が止まっていた間に他プロジェクトのイメージに更新が出ていないかを確認する (再開した瞬間にそれらが再作成される。許容できない場合は、watchtower 側で `WATCHTOWER_MONITOR_ONLY=true` などにしてから再開する)。再開後 5 分間 (`WATCH_SECS`)、サービスが再作成されないことを見る。再作成されたら、watchtower を止めて報告する。
8. **確認**: `postcheck.sh --skip-image-check` (載せ替えたイメージは `NEW_IMAGE_*` と一致しないため)。

旧 DB の postgres コンテナは、72 時間後に `docker compose stop postgres` で止める (watchtower による再起動を避けるため。ボリュームは 1 週間残す)。

## 11. 未決事項と既知のリスク

- **本番の compose の実体**: 本番ホストの compose が、リポジトリの `compose.yaml` とサービス名、`DATABASE_URL` の形式 (`postgres` ホスト) を共有している前提で作ってある。違う場合は `preflight.sh` の「service defined」と「override generation」が FAIL になる。
- **権限同期スクリプトの互換性**: `scripts/db/run-migration-and-sync-grants.sh` (viewer と analyzer の権限の同期と検証) が新スキーマで通ることは、scratch の新 DB (baseline のみ) で確認した範囲に限る。本番相当の通しは、Task 9 のリハーサルの新 DB で `switch.sh roles` を 1 回通して確認すること。
- **`updated` の扱い**: 旧データの `changeType='updated'` を残すか (`KEEP_UPDATED`、`ENUM_UPDATED`) は、Task 9 の未決事項でユーザーの判断が要る。
- **エラー率の基準**: `postcheck.sh` の基準は、`docker logs` の保持範囲 (ログドライバの上限は 10MB × 3 ファイル) の `error` 行数で、切り替え前の 1 週間の比較ではない。72 時間の受け入れ基準は GlitchTip で確認する。
- **relabeler のスループット**: 切り替え前の値 (`RELABEL_BASELINE_PER_MIN`) を指定しないと、判定せずに表示するだけになる。
- **ディスク**: 既定の必要量 (データ 80GiB、アーカイブ 10GiB、ベースバックアップ 70GiB) は約 160GiB で、仕様書の想定の空き (約 145GiB) を超える。ベースバックアップを `/mnt/hdd` などへ置くか (`NEW_DB_BACKUP_HOST_PATH`)、必要量を実測で見直す。
- **最初のベースバックアップに `stg` が含まれる**: `steady` は `finish` (stg と mig の削除) の前に実行される。最初のバックアップは検証用の作業表を含むため大きい。以後のバックアップは小さくなる。
- **将来の migration**: アプリ用ロールは所有者でないため、今後のスキーマ変更は所有者ロールの一回限りのコンテナで実行する (2.4)。
- **新 DB は別の compose プロジェクト**: ホストの再起動では `restart: unless-stopped` で戻り、ネットワークの接続も維持される。コンテナを作り直すと、ネットワークの接続をやり直す必要がある。恒久的には、新 DB を本番の compose に入れる (10 章の 4)。

## 12. 手順書の検証

`cutover/selftest.sh` は、scratch のコンテナ (名前は `tac-t11st` 始まり) だけで、次を通しで実行して検査する。本番には触れない。

- dry-run が何も変えないこと。
- 旧 DB の読み取り専用の凍結が失われると、移行が進まず `switch.sh` が拒否し、`rollback.sh` で旧状態へ戻ること。
- 時間の目安を超えても、移行と切り替えが警告だけで完了まで進むこと。検証ゲートの FAIL では止まり、直すと再開できること。
- 未解決の outbox があると `freeze.sh` が拒否し、blocker は止まるが他のサービスは止まらないこと。
- 通しの切り替え (旧 DB はスキーマに migration を適用して架空のデータを入れたもの、新 DB は baseline に対して Task 9 の `load.sh` と `verify.sh` で投入)。各サービスのイメージと `DATABASE_URL` の書き換え (クエリ文字列と専用ロールの保持を含む)、アプリ用ロールが非スーパーユーザーで直接 DML が拒否されること、`wal_level=replica`、`postcheck.sh` の通過。
- 切り替え後のロールバックで、旧イメージ、旧 DB、書き込み可、blocker 停止、他プロジェクトのコンテナの不変が成り立つこと。
- 24 時間の観察後にだけ blocker が起動し、起動後はロールバックが拒否されること。
- `reenable-watchtower.sh` が、不一致の間は再開を拒否し、載せ替えの後に再開すること。

実行時間と結果は、PR の説明に記録する。
