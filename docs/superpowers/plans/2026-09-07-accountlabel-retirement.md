# AccountLabel テーブル退役実装計画

- Status: written plan (実装未着手)
- Author: planning agent
- Spec: `docs/superpowers/specs/2026-09-07-accountlabel-retirement-design.md` (written spec approved)
- Baseline: master `01119ae` 系列 (spec コミット、spec 修正 amend 後の最新)

## リリース構成 (CRITICAL)

本計画は **2 つの独立したリリース** に分割し、両者の間に **ハードな運用チェックポイント** を置く。

- **Release 1** (Phase 1、本計画 P1-1〜P1-11): spec の Stage 0 (依存除去) + Stage 2 (rename migration) のみを含む。
  **`DROP TABLE "AccountLabelLegacy"` および `ALTER TABLE "AccountLabelChange" DROP COLUMN "sourceLabelId"` は
  Release 1 のブランチ・コミット・migration ファイルのどこにも存在してはならない。** P1-11 でこれを機械的に確認する。
- **Hard Operational Checkpoint**: Release 1 がマージ・本番デプロイされ、同日中の本番カナリア確認 (G1+G2) が
  全 green になり、かつ DROP 前提の論理バックアップ (Backup Gate) が取得・検証済みになるまで、
  Release 2 のブランチを作成しない。
- **Release 2** (Phase 2、本計画 P2-1〜P2-5): 上記チェックポイントが green になった後、
  **マージ済みの master から新規に branch off** して作成する。Stage 3 (DROP) のみを含む。

Phase 1 と Phase 2 は別々の branch・別々の PR とする (spec §5 のとおり、1 回の `prisma migrate deploy` に
rename と DROP を同時に含めない)。

---

## Phase 1: Release 1 (Stage 0 依存除去 + Stage 2 rename migration)

### P1-1: crawl 経路の raw `AccountLabel` INSERT 停止

- **Files**:
  - Modify: `crawler/db/label-repository.ts`
  - Test: `crawler/db/label-repository.test.ts`
- **Depends on**: なし
- **Change**:
  1. `recordCrawlAccountLabelsAtomicWithinTx` 内の `recordAccountLabelsBulkCore` 呼び出し
     (現状 L575 付近、`claimedLabels.map((label) => ({ ...label, accountId: params.accountId }))` を渡している箇所) を、
     `recordAccountLabelsBulkLatestOnlyForAccounts(prisma, { labels: claimedLabels.map((label) => ({ ...label, accountId: params.accountId })), sourceKind: 'crawl', sourceId: params.crawlRunId, sourceUsername: params.username })`
     の呼び出しに置き換える。
  2. `recordAccountLabelsBulkCore` (private 関数、`AccountLabel` への `INSERT` を含む CTE を持つ)、
     `recordAccountLabelsBulk` (export、単数形、production 呼び出し元なしを確認済み)、
     `recordCrawlAccountLabel` (export、単数形、production 呼び出し元なしを確認済み、spec §1 で死んだコードと確定) を削除する。
  3. 上記削除に伴い不要になる型 `RecordAccountLabelParams`、`RecordCrawlAccountLabelParams`、`RecordAccountLabelRow`、
     `RecordAccountLabelsBulkParams`、`RecordAccountLabelsBulkRow` を削除する。
  4. ファイル冒頭の `import type { AccountLabel, LabelDefinition, Prisma, PrismaClient } from '../generated/prisma'` から
     `AccountLabel` を除去する (P1-6 で schema からモデルが消えると型が存在しなくなるため)。
  5. `crawler/db/account-repository.ts` のコメント (`recordAccountLabelsBulk()` への言及、L264 付近) を
     `recordAccountLabelsBulkLatestOnlyForAccounts()` への言及に書き換える。
- **Contracts/Invariants**: `recordCrawlAccountLabelsAtomicWithinTx` の
  claim (`CrawlAccountLabelRun` への INSERT) → `AccountLabelLatest` upsert →
  `AccountLabelLatest` 再読込による snapshot 構築 → `AccountClassificationObservation` 作成 →
  `account_summary_refresh` work item enqueue、という順序・戻り値 (`observation.id | null`) は変更しない (spec §8.2)。
- **Verification**:
  1. RED: `label-repository.test.ts` の `describe('recordCrawlAccountLabelsAtomicWithinTx', ...)` 内の既存テストが
     mock した `$queryRaw`/`$executeRaw` の呼び出し内容 (`INSERT INTO "AccountLabel"` を含む CTE) を
     期待するアサーションのままだと、実装変更後に失敗することを一度確認する。
  2. そのテストを、`recordAccountLabelsBulkLatestOnlyForAccounts` 相当の `AccountLabelLatest` のみへの
     `$executeRaw` 呼び出しを期待する内容に書き換える。
  3. GREEN: `pnpm --filter crawler exec vitest run db/label-repository.test.ts` が green。
  4. `grep -c '"AccountLabel"' crawler/db/label-repository.ts` が `0` (raw SQL 内のテーブル名リテラルが消えていること)。
- **Stop Conditions**: `recordAccountLabelsBulkLatestOnlyForAccounts` の
  `WHERE "AccountLabelLatest"."labeledAt" <= EXCLUDED."labeledAt"` ガードが
  crawl の入力形状 (`AccountLabelBulkInput`) と非互換であれば、このタスクを完了とせず設計を再確認する。
- **Assumptions**: `recordAccountLabelsBulk` (単数形) は現状も production から呼ばれていない
  (`grep -rln "recordAccountLabelsBulk\b" --include=*.ts crawler/ | grep -v test` で `label-repository.ts` と
  コメントのみの `account-repository.ts` しかヒットしないことを確認済み)。これを削除しても本番挙動に影響しない。

### P1-2: relabel 経路のフラグ削除

- **Files**:
  - Modify: `crawler/relabel-worker.ts`、`crawler/config/env.ts`、`crawler/db/label-repository.ts`
  - Test: `crawler/relabel-worker.test.ts`、`crawler/config/env.test.ts`
- **Depends on**: P1-1 (`recordAccountLabelsBulkCore` 削除と整合させるため同一リリース内で連続して行う)
- **Change**:
  1. `crawler/relabel-worker.ts` の
     `const recordLabels = isRelabelAccountLabelHistoryWriteEnabled() ? recordAccountLabelsBulkForAccounts : recordAccountLabelsBulkLatestOnlyForAccounts`
     という三項分岐 (現状 L297-299 付近) を、`recordAccountLabelsBulkLatestOnlyForAccounts` の直接呼び出しに置き換える。
     import 文から `recordAccountLabelsBulkForAccounts`、`isRelabelAccountLabelHistoryWriteEnabled` を除去する。
  2. `crawler/db/label-repository.ts` の `recordAccountLabelsBulkForAccounts` (export 関数) を削除する。
     `RecordAccountLabelsBulkForAccountsParams` インターフェースは `recordAccountLabelsBulkLatestOnlyForAccounts` が
     引き続き使うため残す。
  3. `crawler/config/env.ts` の `isRelabelAccountLabelHistoryWriteEnabled` 関数を削除する。
- **Verification**:
  1. RED: `crawler/relabel-worker.test.ts` の `RELABEL_ACCOUNT_LABEL_HISTORY_WRITE_ENABLED` を
     切り替えて呼び出し先の違いを検証しているテスト (現状 L804 付近、`process.env.RELABEL_ACCOUNT_LABEL_HISTORY_WRITE_ENABLED`
     を操作するブロック) を削除し、「常に `recordAccountLabelsBulkLatestOnlyForAccounts` が呼ばれること」を
     検証する単一のテストに置き換える。
  2. `crawler/config/env.test.ts` の `describe('isRelabelAccountLabelHistoryWriteEnabled', ...)` ブロック
     (現状 L422-446 付近) を削除する。
  3. GREEN: `pnpm --filter crawler exec vitest run relabel-worker.test.ts config/env.test.ts` が green。
  4. `grep -rn "RELABEL_ACCOUNT_LABEL_HISTORY_WRITE_ENABLED\|recordAccountLabelsBulkForAccounts" crawler --include=*.ts | grep -v '\.test\.ts'`
     が 0 件。
- **Stop Conditions**: `recordAccountLabelsBulkForAccounts` 固有の history 付き挙動を検証する既存テストが
  他にもあり、単純な置き換えでは意図が失われる場合、そのテストの意図をまず確認してから書き換える。
- **Assumptions**: 本番はすでに `RELABEL_ACCOUNT_LABEL_HISTORY_WRITE_ENABLED=false` で稼働しており
  (spec §1)、フラグ削除後の恒久的な挙動 (`recordAccountLabelsBulkLatestOnlyForAccounts` のみ) は
  本番の現在の実際の挙動と一致する。

### P1-3: analyzer legacy fallback 削除

- **Files**:
  - Modify: `analyzer/read-models/build-account-summary-latest-row.ts`、`analyzer/worker-processors.ts`
  - Test: `analyzer/read-models/build-account-summary-latest-row.test.ts`、`analyzer/worker-processors.test.ts`
- **Depends on**: なし (P1-1/P1-2 と並行可能)
- **Change**:
  1. `build-account-summary-latest-row.ts` から `LabelAtWatermark` インターフェース、
     `findLabelsAtWatermarkForAccount`、`findPreviousLabelAtWatermarkForAccount` (現状 L1-70) を削除する。
     `ActiveFindingAtWatermark`/`findActiveFindingsAtWatermarkForAccount` (L72-103、finding 用で対象外) は残す。
  2. `worker-processors.ts` の import から `findLabelsAtWatermarkForAccount`、`findPreviousLabelAtWatermarkForAccount`、
     `LabelAtWatermark` を除去する。
  3. `processAccountSummaryRefresh` を簡略化する: `useSnapshot` 変数と `if (useSnapshot) return` 以降の
     legacy `AccountLabelChange` 生成ブロック (`previousByLabelDefinitionId`・`sourceLabelId` 冪等キーによる
     `changeClient.upsert`/`findFirst` を含む一連の for ループ)、および `Promise.all` 内の watermark 分岐
     (`findLabelsAtWatermarkForAccount(...)`/`findPreviousLabelAtWatermarkForAccount(...)` の三項) を削除し、
     常に `parseClassificationSnapshot(observation.accountId, observation.classificationSnapshot)` のみを
     使う形に書き換える。`previousLabels` は不要になるため削除する。
- **Verification**:
  1. RED: `build-account-summary-latest-row.test.ts` の
     `describe.skipIf(!process.env.DATABASE_URL)('findLabelsAtWatermarkForAccount', ...)` と
     `findPreviousLabelAtWatermarkForAccount` を検証するテストを削除する。
  2. `worker-processors.test.ts` の `'snapshotless legacy fallback does not audit confidence/reason-only changes'`、
     `'snapshotless legacy fallback adopts a pre-migration audit row without duplicating it'`、および
     「同じ snapshotless WorkItem を再処理しても raw AccountLabel.id で冪等になる」ことを検証するテスト
     (現状 L524-532 付近) を削除する。
     「snapshot 分岐では `AccountLabel` への watermark 復元クエリを一切発行しないこと」を検証するテスト
     (現状 L821 付近) は、`vi.spyOn(accountSummaryLatestRowModule, 'findLabelsAtWatermarkForAccount')` など
     削除対象の関数を spy する形になっており、当該関数自体が削除されるとこの spy 呼び出し自体が
     型エラーになる。そのため spy ベースの記述は流用できず、「常に snapshot 経路のみで処理され、
     `AccountLabel` へのクエリが一切発行されないこと」を検証する別の手段 (例: `AccountLabel` への
     クエリ発行を検知できる Prisma クライアントの mock/spy に置き換える、または実 DB に対する
     integration test で `pg_stat_statements`/クエリログを確認する) に書き換える。
  3. GREEN: `DATABASE_URL` を設定した状態で
     `pnpm --filter analyzer exec vitest run worker-processors.test.ts read-models/build-account-summary-latest-row.test.ts`
     が green。
  4. `grep -rn "findLabelsAtWatermarkForAccount\|findPreviousLabelAtWatermarkForAccount\|LabelAtWatermark" analyzer --include=*.ts | grep -v '\.test\.ts'`
     が 0 件。
- **Stop Conditions**: 本タスク着手前に、本番の snapshotless nonterminal 件数が 0 であること
  (spec §12 G1a のクエリ) を確認できない場合はこのタスクを実施せず停止する
  (このクエリ自体は Hard Operational Checkpoint の C2 で正式に確認するが、実装前の事前確認としても行う)。
- **Assumptions**: spec §1/§9 のとおり本番の snapshotless nonterminal 件数は現在 0 であり、
  crawl は常に `snapshotVersion=1` を設定し relabel は `AccountClassificationObservation` を作成しない。

### P1-4: viewer account-detail history の移行

- **Files**:
  - Modify: `viewer/lib/queries/account-detail.ts`、`viewer/app/components/account-labels.tsx`
  - Test: `viewer/lib/queries/account-detail.test.ts`、`viewer/app/components/account-labels.test.tsx`
- **Depends on**: なし (P1-1/P1-2/P1-3 と並行可能)
- **Change**:
  1. `AccountDetailLabelHistoryEntry` を
     `{ changeType: 'added' | 'removed'; previousValue: boolean | null; newValue: boolean | null; previousConfidence: number | null; newConfidence: number | null; previousReason: string | null; newReason: string | null; changedAt: Date }`
     に置き換える (`method`/`ruleVersion` を削除、spec §10.2-3)。
  2. `ACCOUNT_LABEL_FETCH_LIMIT` を `ACCOUNT_LABEL_CHANGE_FETCH_LIMIT` にリネームする (値は既存の `2000` を維持、spec §10.2-5)。
  3. `buildLabelHistoryByDefinition` を、`AccountLabelChange` の行 (`labelDefinitionId, changeType, previousValue, newValue,
     previousConfidence, newConfidence, previousReason, newReason, changedAt`) を `labelDefinitionId` ごとに
     `LABEL_HISTORY_LIMIT`(20件) まで集約する形に書き換える。「直前の1件を除外する」ロジック (`seenMostRecent`) を削除する
     (spec §10.2-2、初回 `added` イベントもそのまま history に含める)。
  4. `groupLabelsByDefinition` の `historyRows` 引数の型を上記の新しい行形状に合わせる。
  5. `getAccountDetail` の
     `prisma.accountLabel.findMany({ where: { accountId }, orderBy: [{ labeledAt: 'desc' }, { id: 'desc' }], take: ACCOUNT_LABEL_FETCH_LIMIT })`
     を
     `prisma.accountLabelChange.findMany({ where: { accountId }, orderBy: [{ changedAt: 'desc' }, { id: 'desc' }], take: ACCOUNT_LABEL_CHANGE_FETCH_LIMIT })`
     に置き換える。
  6. `viewer/app/components/account-labels.tsx` の history 表示部分を、`changeType` バッジ、
     `previousValue → newValue`・`previousConfidence → newConfidence`・`previousReason → newReason` の前後表示、
     `changedAt` 表示に更新し、`method`/`ruleVersion` の history 表示を削除する (現在値表示の `method`/`ruleVersion` は変更しない)。
     history 0 件時のコピーを「このラベルの value 遷移の記録はまだありません (過去に評価されていた可能性があります)」の
     趣旨に沿った文言にする (spec §10.3-3)。
- **Verification**:
  1. RED: `account-detail.test.ts` の既存 fixture (`prisma.accountLabel.findMany` を mock するもの) を、
     `prisma.accountLabelChange.findMany` を mock する fixture に置き換え、spec §10.4 の4ケース
     (初回 `added` のみ、`added→removed→added` の複数遷移、一度も `true` にならないラベルの history 0件、
     `LABEL_HISTORY_LIMIT`/`ACCOUNT_LABEL_CHANGE_FETCH_LIMIT` の打ち切り境界) をテストとして追加する。
     書き換え直後、実装がまだ `prisma.accountLabel` を呼んでいる間はこれらが失敗することを確認する。
  2. `account-labels.test.tsx` を新しい `AccountDetailLabelHistoryEntry` 形状に合わせて更新する。
  3. GREEN: `pnpm --filter viewer exec vitest run lib/queries/account-detail.test.ts app/components/account-labels.test.tsx`
     が green。
  4. `grep -rn "prisma\.accountLabel\b" viewer --include=*.ts | grep -v '\.test\.ts'` が 0 件。
- **Stop Conditions**: なし (DB スキーマ変更を要さない読み取りクエリの切り替えのみ)。
- **Assumptions**: `AccountLabelChange` には既に `@@index([accountId, labelDefinitionId, changedAt])` 等の索引が
  存在する (migration `20260906010000`、schema L1012-1014) ため、この切り替えのために新規 index は不要。

### P1-5: `sync-analyzer-grants.sql` コメント修正

- **Files**: Modify: `scripts/db/sync-analyzer-grants.sql`
- **Depends on**: なし
- **Change**: ファイル冒頭の正本テーブル一覧コメント (`-- 正本テーブル (Account, Tweet, AccountLabel, AccountLabelLatest, ...)`)
  から `AccountLabel` を除去する (`AccountLabel, AccountLabelLatest` → `AccountLabelLatest`)。
  grant/revoke の実体 (ブランケット `GRANT SELECT ON ALL TABLES` 方式) は変更しない (spec §7.3)。
- **Verification**:
  1. `grep -n "AccountLabel,"  scripts/db/sync-analyzer-grants.sql` が 0 件。
  2. fresh PG17 上で `bash scripts/db/run-migration-and-sync-grants.sh` (CI `db-grants-verification` ジョブと同じ手順) が green
     (コメントのみの変更のため、grant の実体に対する既存検証が壊れないことの確認)。
- **Stop Conditions**: なし。

### P1-6: Prisma schema からのモデル/フィールド削除

- **Files**: Modify: `prisma/schema.prisma`
- **Depends on**: P1-1, P1-2, P1-3, P1-4 (これらが `AccountLabel` 型・`sourceLabelId` フィールドへの
  コード参照をすべて除去していることが前提)
- **Change**:
  1. `model AccountLabel { ... }` (全体) を削除する。
  2. `model Account` の `labels AccountLabel[]` フィールドを削除する。
  3. `model LabelDefinition` の `accountLabels AccountLabel[]` フィールドを削除する。
  4. `model AccountLabelChange` の `sourceLabelId String? @unique` フィールドを削除する
     (DB 上のカラム自体は Stage 3 の DROP migration まで物理的に残る、spec §7.4)。
     直前のコメント (`// legacy snapshotless analyzer の再構築経路では、変化元 AccountLabel.id を sourceLabelId として保持し、...`)
     を、「Prisma schema からは削除済みだが DB カラムは Stage 3 の DROP まで残る」旨に更新する。
- **Verification**:
  1. `pnpm --filter crawler exec prisma validate --schema=../prisma/schema.prisma` が成功する。
  2. `pnpm --filter crawler exec prisma generate --schema=../prisma/schema.prisma` が成功する。
  3. `pnpm --filter crawler run typecheck && pnpm --filter analyzer run typecheck && pnpm --filter viewer run typecheck`
     がすべて green (P1-1〜P1-4 が `AccountLabel` 型参照をすべて除去済みであることの型レベル証明)。
- **Stop Conditions**: typecheck が `AccountLabel`/`sourceLabelId` 型未解決で失敗した場合、
  このタスク自体は新規コード変更を行わず、参照が残っている P1-1〜P1-4 のタスクに戻って修正する。
- **Assumptions**: `prisma validate`/`prisma migrate` は schema に定義のないテーブル・カラムが
  DB 側に存在すること自体をエラーにしない (spec §7.4)。

### P1-7: 静的検査 (grep) スクリプトの追加

- **Files**:
  - Create: `scripts/verify-no-account-label-code-references.sh`
  - Modify: `.github/workflows/nodejs-ci.yml`
- **Depends on**: P1-1, P1-2, P1-3, P1-4, P1-6 (検査対象のコードが先にクリーンになっていること)
- **Change**: `prisma/migrations/verify-drop-unused-account-label-history-indexes.test.sh` と同じ shell テスト
  パターン (`set -eu`、`fail()` ヘルパ、最後に非0件で `exit 1`) に従い、以下を検証するスクリプトを新規作成する
  (spec §11 の要件そのもの):
  1. `prisma/schema.prisma` に `model AccountLabel {` および `model AccountLabelLegacy {` という宣言が
     存在しないこと。
  2. `model Account`/`model LabelDefinition` の本体に `AccountLabel[]` という型注釈を持つフィールドが
     存在しないこと。
  3. production コード (`crawler/`, `analyzer/`, `viewer/`, `blocker/`, `review/`, `queue/` 配下の
     `*.test.ts` を除く全 `.ts`、かつ `prisma/migrations/**`・`docs/**` を除外) に、単語境界を伴う
     `"AccountLabel"`/`'AccountLabel'` (`AccountLabelLatest`/`AccountLabelChange`/`AccountLabelDefinition`/
     `CrawlAccountLabelRun` を誤検出しない正規表現) および `prisma.accountLabel`/`prisma.accountLabelLegacy`
     という呼び出しが存在しないこと。
  4. `recordCrawlAccountLabel\b`、`recordAccountLabelsBulkForAccounts\b`、
     `RELABEL_ACCOUNT_LABEL_HISTORY_WRITE_ENABLED` という識別子が production コードに存在しないこと。
  `.github/workflows/nodejs-ci.yml` の `db-grants-verification` ジョブの「Verify operational shell scripts」
  ステップに `sh scripts/verify-no-account-label-code-references.sh` を追加する。
- **Verification**:
  1. RED: このスクリプトを P1-1〜P1-6 適用前の worktree のコピーに対して一時的に実行し、
     `recordCrawlAccountLabel`/`RELABEL_ACCOUNT_LABEL_HISTORY_WRITE_ENABLED`/`model AccountLabel` の
     いずれかで確実に fail することを確認してからスクリプトを完成させる。
  2. GREEN: P1-1〜P1-6 適用後のワークツリーに対し `sh scripts/verify-no-account-label-code-references.sh` を実行し、
     `OK: ...` を出力して exit 0 になることを確認する。
  3. CI 上で `.github/workflows/nodejs-ci.yml` の `db-grants-verification` ジョブが green。
- **Stop Conditions**: 正規表現が `AccountLabelLatest`/`AccountLabelChange`/`AccountLabelDefinition`/
  `CrawlAccountLabelRun` を誤検出する場合、パターンを修正するまでこのタスクを完了としない。

### P1-8: rename migration ファイルの作成

- **Files**:
  - Create: `prisma/migrations/<実行時タイムスタンプ>_rename_account_label_to_legacy/migration.sql`
  - Create: `prisma/migrations/<実行時タイムスタンプ>_rename_account_label_to_legacy/verify-rename-account-label-legacy.test.sh`
  - Modify: `.github/workflows/nodejs-ci.yml`
- **Depends on**: P1-6 (schema からモデルが消えており、この migration が DDL のみになることが前提)
- **Change**:
  1. `pnpm --filter crawler exec prisma migrate dev --create-only --name rename_account_label_to_legacy --schema=../prisma/schema.prisma`
     を実行し、実タイムスタンプ付きの migration ディレクトリを生成する。P1-6 が正しく適用済みであれば、
     生成される `migration.sql` は **空** のはずである (Prisma 側の diff がないため)。空でない diff が
     生成された場合は P1-6 の schema 変更が不完全なので、そちらへ戻って修正する。
  2. 生成された空の `migration.sql` を以下の内容で置き換える:
     ```sql
     BEGIN;
     SET LOCAL lock_timeout = '3s';
     SET LOCAL statement_timeout = '30s';
     ALTER TABLE "AccountLabel" RENAME TO "AccountLabelLegacy";
     COMMIT;
     ```
  3. 同ディレクトリに `verify-drop-unused-account-label-history-indexes.test.sh` と同じパターンの
     検証スクリプトを作成し、`migration.sql` の内容 (コメント・空行を除いた実ステートメント) が
     上記の `BEGIN;`/`SET LOCAL lock_timeout = '3s';`/`SET LOCAL statement_timeout = '30s';`/
     `ALTER TABLE "AccountLabel" RENAME TO "AccountLabelLegacy";`/`COMMIT;` の5行と完全一致することをアサートする。
  4. `.github/workflows/nodejs-ci.yml` の「Verify operational shell scripts」ステップに、この新しい
     `verify-rename-account-label-legacy.test.sh` の実行を追加する。
- **Verification**:
  1. fresh PG17: CI の PG17 サービスコンテナ (`db-grants-verification`/`db-integration-tests` と同じイメージ
     `postgres:17-alpine`) に対して `pnpm --filter crawler run db:migrate` を実行し、この migration が
     成功することを確認する。
  2. 適用後、`psql "$DATABASE_URL" -c "SELECT to_regclass('\"AccountLabelLegacy\"');"` が非 NULL、
     `psql "$DATABASE_URL" -c "SELECT to_regclass('\"AccountLabel\"');"` が NULL を返すことを確認する。
  3. `sh prisma/migrations/<タイムスタンプ>_rename_account_label_to_legacy/verify-rename-account-label-legacy.test.sh`
     が green。
- **CRITICAL 制約**: このタスクで作成するファイルに `DROP TABLE`/`DROP COLUMN` を一切含めてはならない。
- **Stop Conditions**: `prisma migrate dev --create-only` が空でない diff を生成した場合、その diff を
  そのまま採用せず、P1-6 に戻ってモデル削除の抜けを解消してから再実行する。
- **Assumptions**: spec §7.1 のとおり `ALTER TABLE ... RENAME` はカタログ更新のみで table rewrite を伴わない。

### P1-9: Release 1 パッケージ全体の `pnpm check`/`pnpm format`

- **Files**: P1-1〜P1-8 で変更した全パッケージ (crawler / analyzer / viewer)
- **Depends on**: P1-1〜P1-8 すべて
- **Verification**:
  ```
  pnpm --filter crawler run check && pnpm --filter crawler run format
  pnpm --filter analyzer run check && pnpm --filter analyzer run format
  pnpm --filter viewer run check && pnpm --filter viewer run format
  ```
  がすべて green。

### P1-10: CI ワークフロー統合の最終確認

- **Files**: `.github/workflows/nodejs-ci.yml` (P1-7・P1-8 で追加したステップの重複がないかの確認のみ、
  新規コード変更は原則不要)
- **Depends on**: P1-7, P1-8
- **Verification**: `git diff origin/master...HEAD -- .github/workflows/nodejs-ci.yml` を目視し、
  追加した2つの検証ステップ (静的検査スクリプト・rename migration 検証スクリプト) が
  `db-grants-verification` ジョブの「Verify operational shell scripts」ステップに1回ずつ、
  他ステップと重複せず追加されていることを確認する。

### P1-11: Release 1 ブランチの DROP 不在最終確認 (CRITICAL)

- **Files**: なし (検証のみ)
- **Depends on**: P1-1〜P1-10 すべて
- **Verification**:
  ```
  git diff origin/master...HEAD -- prisma/migrations | grep -iE 'DROP TABLE "AccountLabelLegacy"|DROP COLUMN "sourceLabelId"'
  ```
  が **何もヒットしない (exit code 1)** ことを確認する。
  さらに `git diff origin/master...HEAD --stat` で、Release 1 のブランチが
  `_drop_account_label_legacy` 系の migration ディレクトリを一切含んでいないことを確認する。
- **Stop Conditions**: 1件でもヒットした場合、その変更を Release 1 ブランチから完全に取り除かない限り
  PR を作成しない。この確認がこの計画における最終ゲートであり、これが green になって初めて
  Release 1 の PR 作成・`/deep-review` (local diff mode) の実行・マージへ進む。

---

## Hard Operational Checkpoint (Release 1 デプロイ後、Release 2 開始前)

このチェックポイントは Release 1 の PR がマージされ、本番へデプロイされた後にのみ開始する。
**Release 2 のブランチは、このチェックポイントの C2・C3・C4 がすべて同日中に green になるまで作成しない。**

### C1: Release 1 のマージ・デプロイ

Release 1 の PR を master にマージし、本番へデプロイする (デプロイ手順自体は ops 側の運用手順であり、
本計画のスコープ外。§15 未解決リスク #3 参照)。

### C2: G1 (Stage 0→1) 検証

- **G1a (時点確認)**:
  ```sql
  SELECT count(*)
  FROM "AnalysisWorkItem" wi
  JOIN "AccountClassificationObservation" o ON o.id = wi."triggerId"
  WHERE wi.kind = 'account_summary_refresh'
    AND wi."triggerType" = 'account_classification_observation'
    AND wi.status NOT IN ('succeeded', 'dead')
    AND o."snapshotVersion" IS NULL;
  ```
  結果が `0` であることを確認する。
- **G1b (静的検査 + 本番手動確認)**: P1-7 の CI grep が green であることに加え、対象を絞った crawl を
  1回手動実行し、
  ```sql
  SELECT "snapshotVersion" FROM "AccountClassificationObservation" WHERE id = '<手動実行で生成された Observation の id>';
  ```
  が `1` を返すことを確認する。続けて analyzer のログで、この Observation が snapshot 経路 (fallback を
  経由せず) で処理し切ったことを確認する。
- **crawl/relabel の書き込み停止確認 (低コスト版)**:
  ```sql
  SELECT n_tup_ins, (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS stats_reset
  FROM pg_stat_user_tables WHERE relname = 'AccountLabel';
  ```
  をデプロイ直後のベースラインと一定時間経過後の2時点で取得し、差分が実質ゼロに収束していること、
  かつ `stats_reset` が2時点間で変化していないことを確認する。
- **viewer health**: account-detail ページのエラー率・レイテンシが切り替え前後で悪化していないこと。
- **review/queue/storage/GlitchTip**: `StorageCapacityState.relabelBlocked = false`、既存ダッシュボードに
  異常がないこと。

### C3: rename DDL の適用と G2 (同日メンテナンス確認)

1. **quiesce**: crawler/analyzer/viewer/blocker/review の各サービスを停止する。
2. `pg_stat_activity` で `AccountLabel` に対する `now() - xact_start > interval '30 seconds'` 程度の
   長時間トランザクションが存在しないことを確認する。
3. **grants ドリフト確認**: rename 実行前に以下を実行し、想定外の grantee/権限がないことを確認する。
   0件でない場合、その grantee/権限が何のために付与されたかを個別に説明できることを rename の前提条件とする。
   ```sql
   SELECT grantee, privilege_type FROM information_schema.role_table_grants
   WHERE table_name = 'AccountLabel' AND grantee NOT IN ('crawler', 'analyzer', 'viewer', 'weekly_review')
   UNION ALL
   SELECT grantee, privilege_type FROM information_schema.role_table_grants
   WHERE table_name = 'AccountLabel' AND grantee IN ('analyzer', 'viewer', 'weekly_review')
     AND privilege_type <> 'SELECT';
   ```
4. P1-8 の rename migration (`prisma migrate deploy`) を適用する。
   **失敗時の復旧手順**: `lock_timeout`/`statement_timeout` により migration が失敗した場合、
   `SELECT to_regclass('"AccountLabelLegacy"');` で実際に rename が commit されたか確認する
   (`BEGIN;`/`COMMIT;` で明示的に括っているため、失敗時は未適用のまま rollback されており部分適用にはならない)。
   未適用を確認したうえで `prisma migrate resolve --rolled-back <migration名>` を実行し、
   quiescing 状態を保ったまま同一 migration を再試行する。手動での部分適用 DDL 実行は行わない。
5. Release 1 のコミット以降のリビジョンでサービスを起動する。
6. 以下を順に (または既存の運用手順が許す順序で) 手動実行し、それぞれが例外なく完了することを確認する:
   1. crawl (対象を絞った1バッチで可) → `AccountClassificationObservation` の snapshot 生成まで。
   2. analyzer の `account_summary_refresh` work item 処理。
   3. relabel 処理。
   4. viewer の account-detail ページ表示・review 画面の表示。
   5. blocker の候補生成処理。
   6. **weekly-review 相当の処理**: `crawler/scripts/weekly-analysis-run.ts create` で検証用の
      `WeeklyAnalysisRun` を作成し run id を取得する → 続けて
      `crawler/scripts/weekly-review-plan.ts build --id <runId> --output <一時 plan ファイルパス>` を実行し、
      planning/read 系の処理経路 (`AccountLabelChange`/`AccountLabelLatest` 等への読み取りを含む) が
      正常に完走することを確認する → 完了後 (または途中で異常があれば)
      `crawler/scripts/weekly-analysis-run.ts fail --id <runId> --message '<理由>'` でこの検証用 run を
      明示的に失敗扱いにして後始末する (`complete` コマンドは実際のレビュー結果を要求するため
      検証目的の合成 run には使わない)。
   7. queue/storage の状態確認 (`StorageCapacityState.relabelBlocked = false`、キュー滞留がないこと)。
7. **`AccountLabelLegacy` への実アクセス検出**:
   ```sql
   SELECT seq_scan, idx_scan, n_tup_ins, n_tup_upd, n_tup_del FROM pg_stat_user_tables WHERE relname = 'AccountLabelLegacy';
   ```
   手動実行の前後で増分が `0` であることを確認する。増分が 0 でない場合、どのサービス/クエリが発生源かを
   `pg_stat_statements` または各サービスのログから特定する。
8. **GlitchTip project 27** の DB growth/root-fix 関連の新規 issue が発生していないことを確認する。
9. 上記いずれかで failure が検出された場合、即座に
   `ALTER TABLE "AccountLabelLegacy" RENAME TO "AccountLabel";` で rename を戻し、
   このメンテナンス作業を停止する。原因究明・修正後、C2 の検証からやり直し、
   改めて別のメンテナンス作業時間で rename を再試行する。

### C4: Backup Gate (Release 2 開始の前提条件)

1. **取得**:
   ```
   pg_dump --format=custom --table='"AccountLabelLegacy"' --file=/mnt/hdd/account_label_legacy_pre_drop.dump "$DATABASE_URL"
   ```
2. **整合性チェックサム**: `sha256sum /mnt/hdd/account_label_legacy_pre_drop.dump` を実行し、値を記録する。
3. **アーカイブ健全性確認**: `pg_restore --list account_label_legacy_pre_drop.dump` でアーカイブ内の目次が
   読めることを確認し、検証用の一時スキーマ/一時 DB へ実際に1回、テーブル定義+データの復元まで通す。
4. 上記1〜3がすべて成功して初めてこのチェックポイントを green とする。いずれかが失敗した場合は
   原因 (ディスク容量不足、権限不足、`pg_dump`/`pg_restore` のバージョン不一致等) を解消してから
   取得をやり直す。

### Checkpoint 完了条件

C2 (G1) + C3 (G2) + C4 (Backup Gate) が **同日中にすべて green** になって初めて、
Phase 2 (Release 2) のブランチを、**Release 1 マージ後の最新 master** から新規に切ってよい。
これより前に Release 2 のブランチ・PR を作成しない。

---

## Phase 2: Release 2 (Stage 3 DROP)

### P2-1: DROP migration ファイルの作成

- **Files**:
  - Create: `prisma/migrations/<実行時タイムスタンプ>_drop_account_label_legacy_and_source_label_id/migration.sql`
  - Create: 同ディレクトリの `verify-drop-account-label-legacy.test.sh`
  - Modify: `.github/workflows/nodejs-ci.yml`
- **Depends on**: Hard Operational Checkpoint 完了 (C2+C3+C4 すべて green)
- **Change**:
  1. `pnpm --filter crawler exec prisma migrate dev --create-only --name drop_account_label_legacy_and_source_label_id --schema=../prisma/schema.prisma`
     で空 diff の migration ディレクトリを生成する (P1-6 の schema 側に `sourceLabelId` フィールドが既に
     存在しないため、Prisma 視点では diff なしのはず)。
  2. `migration.sql` を以下の内容で置き換える:
     ```sql
     BEGIN;
     SET LOCAL lock_timeout = '3s';
     SET LOCAL statement_timeout = '30s';
     DROP TABLE "AccountLabelLegacy";
     ALTER TABLE "AccountLabelChange" DROP COLUMN "sourceLabelId";
     COMMIT;
     ```
  3. `verify-drop-unused-account-label-history-indexes.test.sh` と同じパターンの検証スクリプトを追加し、
     `migration.sql` の内容 (コメント・空行を除いた実ステートメント) が上記の5行と完全一致することをアサートする。
  4. `.github/workflows/nodejs-ci.yml` の「Verify operational shell scripts」ステップに、この検証スクリプトの
     実行を追加する。
- **Verification**:
  1. fresh PG17: CI の PG17 サービスコンテナに対し、P1-8 の rename migration 適用後の状態から
     `pnpm --filter crawler run db:migrate` を実行し、この DROP migration が成功することを確認する。
  2. 適用後、`psql "$DATABASE_URL" -c "SELECT to_regclass('\"AccountLabelLegacy\"');"` が NULL、
     `psql "$DATABASE_URL" -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'AccountLabelChange' AND column_name = 'sourceLabelId';"`
     が 0 行を返すことを確認する。
  3. `sh prisma/migrations/<タイムスタンプ>_drop_account_label_legacy_and_source_label_id/verify-drop-account-label-legacy.test.sh`
     が green。
- **Stop Conditions**: Hard Operational Checkpoint が green になっていないまま着手しない。

### P2-2: Grants 静的検査の回帰確認

- **Files**: 変更なし想定 (`scripts/db/verify-analyzer-grants.sql`/`verify-viewer-grants.sql`/`verify-weekly-review-grants.sql`
  はいずれも `to_regclass`/`has_table_privilege` ベースでテーブル一覧を動的に取得しており、
  `AccountLabel`/`AccountLabelLegacy` を名指ししていないため、テーブル消滅後も自動的に対象外になる想定)
- **Depends on**: P2-1
- **Verification**: fresh PG17 上で DROP migration 適用後に `bash scripts/db/run-migration-and-sync-grants.sh` を
  実行し、green であることを確認する。
- **Stop Conditions**: もし何らかの grants スクリプトが `AccountLabel`/`AccountLabelLegacy` を明示的に
  名指ししていることが判明した場合 (このタスク実行時点で判明)、その行を除去する変更を追加する。

### P2-3: 静的検査 (P1-7 のスクリプト) の DROP 後回帰確認

- **Depends on**: P2-1
- **Verification**: `sh scripts/verify-no-account-label-code-references.sh` が引き続き green であること
  (Release 2 はコード変更を伴わない DDL のみのため、新たに fail する要素はないはずだが回帰確認として実行する)。

### P2-4: Release 2 パッケージの `pnpm check`

- **Depends on**: P2-1
- **Verification**: `pnpm --filter crawler run check && pnpm --filter crawler run format` が green
  (schema.prisma のコメント更新のみであり、実コード変更は伴わない想定)。

### P2-5: DROP 実行 (本番オペレーション) と G3

- **Files**: なし (運用手順)
- **Depends on**: P2-1〜P2-4、かつ Hard Operational Checkpoint の C4 (Backup Gate) が
  取得済み・健全性確認済みであること
- **Change**: Release 2 の migration を本番にデプロイする前に、C3 と同じ quiescing 手順
  (対象サービス停止 → `pg_stat_activity` で長時間トランザクション不在確認 → migration 実行 → 起動) を
  再度行う。DROP 実行直前に、以下を最終防衛として再確認してから `prisma migrate deploy` を実行する。
  1. spec §7.1 の FK/VIEW/publication/function 依存 0件の再確認クエリ (rename から DROP までの間に
     新たな依存が追加されていないことの確認):
     ```sql
     SELECT conrelid::regclass, conname FROM pg_constraint
     WHERE confrelid = '"AccountLabelLegacy"'::regclass AND contype = 'f';
     ```
  2. C3 と同じ grants ドリフト確認クエリ (`table_name = 'AccountLabelLegacy'` に読み替えたもの) を再実行する。
  **失敗時の復旧手順**: DROP migration (`DROP TABLE "AccountLabelLegacy";` と
  `ALTER TABLE "AccountLabelChange" DROP COLUMN "sourceLabelId";` の2文) が
  `lock_timeout`/`statement_timeout` で失敗した場合、`SELECT to_regclass('"AccountLabelLegacy"');` と
  `SELECT column_name FROM information_schema.columns WHERE table_name = 'AccountLabelChange' AND column_name = 'sourceLabelId';`
  で両 DDL が実際に commit されたか確認する (`BEGIN;`/`COMMIT;` で括っているため、失敗時は両方とも
  未適用のまま rollback されており、片方だけ適用された中間状態にはならない)。未適用を確認したうえで
  `prisma migrate resolve --rolled-back <migration名>` を実行し、quiescing 状態を保ったまま
  同一 migration を再試行する。手動での部分適用 DDL 実行は行わない。
- **Verification (G3)**:
  1. `SELECT to_regclass('"AccountLabelLegacy"');` が `NULL`。
  2. ホストのディスク空き容量 (`storage-guard-cycle.ts` が測定する `available_gib`) が DROP 前と比較して
     有意に増加している (オーダーで確認、正確なバイト数一致は保証しない)。
  3. `pg_stat_user_tables`/`pg_class` に `AccountLabel`/`AccountLabelLegacy` 由来の行が残っていない。
  4. crawler/analyzer/viewer/blocker/review の各ヘルスチェック HTTP ステータスが DROP 前後で変化していない。
  5. `StorageCapacityState.relabelBlocked` が `false` のまま。
- **Stop Conditions**: C4 (Backup Gate) のバックアップ取得・sha256・`pg_restore` 健全性確認が完了して
  いない場合、DROP を実行しない。DROP 実行前の依存 0件再確認で1件でも検出された場合、DROP を延期し
  原因究明を優先する。

---

## ロールバック・マトリクス

| 対象 | ロールバック手段 | 可逆性 |
| --- | --- | --- |
| Release 1 (マージ前) | PR をマージしない。 | 完全に可逆。 |
| Release 1 (マージ後・rename 実行前、C1〜C2) | コミットを revert し前バージョンへ再デプロイする (DB 側の DDL は未実行のため、コード revert のみで完全に戻る)。 | 完全に可逆。 |
| C3 (rename 実行後・同日メンテナンス確認中) | `ALTER TABLE "AccountLabelLegacy" RENAME TO "AccountLabel";` で即座に戻す (メタデータ操作でデータは無傷)。 | 完全に可逆。 |
| Release 2 (マージ後・DROP 実行前、P2-1〜P2-4 相当がデプロイ済みでも DROP 未実行の間) | DROP migration 自体をまだ適用していないため、コード revert のみで戻せる (DB に変更なし)。 | 完全に可逆。 |
| P2-5 (DROP 実行後) | **不可逆。** 復元手段は C4 で取得した `AccountLabelLegacy` 単体の `pg_dump --format=custom` ロジカルバックアップを `pg_restore` することのみ。`sourceLabelId` カラムの値もこのバックアップ取得時点のスナップショットにしか残らない。 | DROP 前は可逆、DROP 後は不可逆。 |

---

## Pre-PR / Post-PR ゲート (両リリース共通)

Release 1・Release 2 のいずれの PR 作成前にも、`~/.claude/rules/workflow.md` の Pre-PR checklist
(`/deep-review` local diff mode の実行、score ≥ 50 の findings 修正) を適用する。
PR 作成後は同ファイルの Post-PR checklist (CI green 確認、Copilot review 依頼・対応、コンフリクト確認) を適用する。
本計画はこれらのゲートの実行そのものを代替するものではなく、実装フェーズで別途実行する。

## 未解決のリスク (spec からの引き継ぎ)

spec §15 に記載の未解決リスク (`pg_stat_user_tables` カウンタのリセット、本番 compose 設定の差分適用、
grep でカバーできない外部ツール参照、`pg_dump` 圧縮率の実測未確認) は、本計画のどのタスクでも解消しない。
該当する運用作業 (C3・C4・P2-5) の実行時に、実装者・運用者が個別に対応する。
