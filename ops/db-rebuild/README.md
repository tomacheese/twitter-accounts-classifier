# 新 DB のインフラ (DB 作り直し)

DB 作り直しで使う新しい postgres コンテナの定義と運用スクリプト。旧 DB (`compose.yaml` の `postgres`) とは、プロジェクト名 (`tac-new-db`)、コンテナ名 (`tac-new-postgres`)、ポート、データディレクトリを分けているため、並べて起動できる。

## ファイル

| ファイル | 内容 |
| --- | --- |
| `compose.new-db.yaml` | postgres コンテナの定義。`DB_PROFILE` で設定プロファイルを選ぶ |
| `conf/postgresql.conf` | 共通設定 (メモリ、autovacuum、`pg_stat_statements`、`track_io_timing`) |
| `conf/profile-bulk.conf` | 一括投入プロファイル (`wal_level=minimal`、`max_wal_senders=0`、`archive_mode=off`) |
| `conf/profile-steady.conf` | 定常運用プロファイル (`wal_level=replica`、`archive_mode=on`) |
| `initdb.sh` | データディレクトリの初期化 (一度だけ) |
| `switch-to-steady.sh` | bulk から steady への切り替えと最初のベースバックアップ |
| `verify-restore.sh` | ベースバックアップを scratch へリストアして検証する |

## initdb の固定値

`initdb.sh` が次の値で初期化する。いずれも作成後に変更できない。

```text
--data-checksums --encoding=UTF8 --locale-provider=builtin --locale=C.UTF-8 --builtin-locale=C.UTF-8
```

builtin provider は OS のロケールに依存せず、musl の alpine イメージでも照合順序がコードポイント順になる (PG17 以降が必要)。`pg_database` では `datlocprovider=b`、`datlocale=C.UTF-8` になる。`datcollate` は `C`、`datctype` は `C.UTF-8` と表示されるが、builtin provider では `datcollate` は使われない。initdb 中に `locale: not found` と `no usable system locales were found` の警告が出るが、builtin provider では無害である。

`initdb.sh` は、`crawler` ロールと `twitter_accounts_classifier` データベースを作り、`pg_stat_statements` と `pg_trgm` の拡張を入れる。

## 使い方

環境変数の既定値は本番向けで、リハーサルや検証では上書きする。

| 環境変数 | 既定値 | 内容 |
| --- | --- | --- |
| `DB_PROFILE` | `bulk` | `bulk` または `steady` |
| `NEW_DB_IMAGE` | `postgres:17-alpine` | 本番の PostgreSQL は 17.11。検証前にイメージのマイナーバージョンを確認する |
| `NEW_DB_DATA_HOST_PATH` | `/mnt/ssd/twitter-accounts-classifier/postgres-new` | データディレクトリ (旧 DB とは別) |
| `NEW_DB_WAL_ARCHIVE_HOST_PATH` | `/mnt/ssd/twitter-accounts-classifier/postgres-new-wal-archive` | WAL アーカイブ先 |
| `NEW_DB_BACKUP_HOST_PATH` | `/mnt/ssd/twitter-accounts-classifier/postgres-new-backup` | ベースバックアップ先 |
| `NEW_DB_PORT` / `NEW_DB_BIND` | `5433` / `127.0.0.1` | 公開ポート。旧 DB (5432) と衝突させない |
| `NEW_DB_PASSWORD` | `crawler` | `initdb.sh` の superuser パスワード。本番の新 DB では必ず上書きする |
| `NEW_DB_MEM_LIMIT` | `10g` | コンテナのメモリ上限 |

```bash
# 1. 初期化 (データディレクトリが空でなければ中断する)
ops/db-rebuild/initdb.sh

# 2. 一括投入用で起動
DB_PROFILE=bulk docker compose -f ops/db-rebuild/compose.new-db.yaml up -d

# 3. 投入と検証ゲートの通過後に、定常運用へ切り替える
ops/db-rebuild/switch-to-steady.sh

# 4. ベースバックアップのリストア検証 (scratch コンテナ)
ops/db-rebuild/verify-restore.sh /mnt/ssd/twitter-accounts-classifier/postgres-new-backup/base-<日時>
```

ホスト側のディレクトリ (データ、アーカイブ、バックアップ) は、postgres ユーザー (uid 70) 所有の 0700 になる。ホストからの確認やコピーは、コンテナ経由で行う。

## 一括投入 (bulk) の方針

- `wal_level=minimal` では、同一トランザクションで作成した表への `COPY ... FREEZE` の WAL が省略される。WAL アーカイブ、`pg_basebackup`、レプリケーションとは両立しない。
- bulk 中は `autovacuum=off` とする。投入済みの表が凍結済みで all-visible のため、投入中の IO を奪わせない。`fsync` と `full_page_writes` は止めない。
- **投入中にクラッシュした場合は、復旧を試みずに新 DB を破棄して作り直す。** データディレクトリとアーカイブ先を空にして `initdb.sh` からやり直す。旧 DB は読み取り専用のまま無傷なので、データ損失にならない。

## 定常運用 (steady) への切り替え

`switch-to-steady.sh` が次を順に実行し、どれかが失敗した時点で中断する。

1. `wal_level` が `minimal` であることを確認し、`CHECKPOINT` する。
2. `DB_PROFILE=steady` でコンテナを再作成する (`wal_level=replica`、`archive_mode=on`)。再起動後に設定値を確認する。
3. `vacuumdb --analyze-only` を実行する (bulk 中は統計がないため)。`SKIP_ANALYZE=1` で省略できる。
4. `pg_switch_wal()` で WAL を 1 本切り替え、`pg_stat_archiver` で成功と失敗なしを確認する。
5. `pg_basebackup` (plain、`-X stream`) で `base-<日時>` を取り、`pg_verifybackup` で検証する。

切り替えは、検証ゲートの通過後に行う。bulk に戻す手順は用意しない。

## バックアップ

- 物理バックアップ (`pg_basebackup` と WAL アーカイブ) を前提とし、`pg_dump` は補助とする。
- `archive_command` は、アーカイブ先に同名ファイルがあれば失敗する。アーカイブ先の空き容量と `pg_stat_archiver.failed_count` を監視する。
- `verify-restore.sh` は、`pg_verifybackup` でバックアップを検証したあと、別ディレクトリへコピーして scratch コンテナで起動し、次を確認する。バックアップと同じ容量の空きが一時的に要る。
  - `data_checksums=on`、リカバリ中でないこと、`wal_level=replica`
  - `datlocprovider=b` と `datlocale=C.UTF-8`
  - `pg_stat_statements` と `pg_trgm` が入っていること
  - 停止後の `pg_checksums --check` が全ブロックで通ること (`SKIP_PG_CHECKSUMS=1` で省略可)
- scratch コンテナは `archive_mode=off` で起動し、本番のアーカイブ先をマウントしない。

## リソース

15GB のホストを他コンテナと共有するため、次の上限で設計している。

| 項目 | 値 | 理由 |
| --- | --- | --- |
| コンテナの `mem_limit` | 10GB | 他コンテナを OOM に巻き込まない |
| `shared_buffers` | 3GB | ホスト RAM の約 20%。残りは OS のページキャッシュに任せる |
| `effective_cache_size` | 8GB | |
| `work_mem` | 32MB | |
| `maintenance_work_mem` | bulk 2GB、steady 1GB | `max_parallel_maintenance_workers=2` のため、インデックス作成の最悪値は 3 倍になる点に注意 |
| `autovacuum_work_mem` | 256MB | 未指定だと `autovacuum_max_workers` 本ぶんの `maintenance_work_mem` が同時に確保される |
| `shm_size` | 1GB | 並列クエリの dynamic shared memory |
| `max_wal_size` | bulk 32GB、steady 8GB | 投入中のチェックポイント頻度を抑える |
| autovacuum (global) | `scale_factor=0.05`、`naptime=30s`、`max_workers=4`、`cost_limit=1000` | 大きい表は baseline で表ごとにさらに下げる |

`random_page_cost` は既定値の 4 のまま変えない。`track_io_timing=on` と `pg_stat_statements` は常に有効にする。

## 注意

- 新 DB は、旧 DB と並べて `/mnt/ssd` の空き (約 145GB) に作る前提である。投入前に空きを確認する。
- アプリのコンテナから新 DB へ接続する経路 (ネットワークの共有など) は、本ファイルでは定義していない。切り替え手順書 (Task 11) で決める。
