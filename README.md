# twitter-accounts-classifier

Twitter をクロールしてツイート・アカウント情報を収集し、青バッジ/スパム/トピックなどのラベルを自動付与するプロジェクト。

## 概要

- `crawler/`: Twitter のタイムライン・ツイート・プロフィールを収集し、`crawler/labels/rules/` のルール群でラベリングして Postgres に保存する Node.js アプリ。6時間ごとに実行する。
- `viewer/`: 収集結果をダッシュボード表示する Next.js アプリ。
- `prisma/`: crawler・viewer が共有する Postgres スキーマ。リポジトリルート直下に置き、両アプリから `--schema=../prisma/schema.prisma` で相対参照する。
- 詳細な設計判断・背景は [SPEC.md](./SPEC.md) を参照。

開発機と本番機 (実運用: クロール・DB・Viewer) を分離した構成を前提とする。開発機では `compose.yaml` でローカルビルドし、本番機では GHCR から pull した image (`compose.prod.yaml`、このリポジトリには含まない) を使う。

## 前提条件

- Docker / Docker Compose
- `data/config.json` (Twitter アカウントの認証情報)
- 別マシンで稼働する cookie-issuer サービス (`tomacheese/twitter-cookie-issuer`) への到達性

## セットアップ

1. `.env.example` を `.env` にコピーし、値を埋める。
2. `data/config.json` を用意する (`email`/`username`/`password`/`otp_secret` を含むアカウント配列)。
3. 初回のみ、Postgres に `viewer`/`analyzer` ロールを作成する。`compose.yaml` の `migrate` サービスは既存ロールへの権限同期・検証だけを毎回自動実行し、ロール自体の作成は行わないため、これを飛ばすと `migrate` サービスがロール不在で失敗する。`scripts/db/create-viewer-role.sql`・`scripts/db/create-analyzer-role.sql` 内の `CHANGE_ME_*_PASSWORD` を `.env` の `VIEWER_DB_PASSWORD`/`ANALYZER_DB_PASSWORD` と同じ値に置き換えたうえで、Prisma migration を実行するテーブル所有者ロール (`crawler`) で1度だけ実行する。
4. `docker compose up -d --build` で起動する。
5. 初回起動時に Prisma のマイグレーション・ラベル定義のシードが自動実行される。

## アクセス

| サービス        | URL                   |
| --------------- | --------------------- |
| Viewer (Web UI) | http://localhost:3000 |

Viewer には認証機構がなく、フォロー・フォロワー・ブロック一覧を含む収集データを誰でも閲覧できる。信頼できるネットワーク内 (開発機・本番機分離構成の内側) からのみアクセスできる前提であり、インターネットに直接公開しないこと。

## 環境変数

| 変数                                  | 必須 | 説明                                                                                                                                                                                                                      |
| ------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                        | ○    | Postgres 接続文字列                                                                                                                                                                                                       |
| `COOKIE_ISSUER_URL`                   | ○    | cookie-issuer サービスの URL。フォールバック値はないため未設定だと起動時にエラーになる                                                                                                                                    |
| `CRAWL_INTERVAL_SECONDS`              | -    | クロール間隔 (秒)。デフォルト 21600 (6時間)                                                                                                                                                                               |
| `CRAWL_STALE_THRESHOLD_MULTIPLIER`    | -    | `running` のまま放置された CrawlRun を検出するしきい値の倍率 (クロール間隔の何倍か)。デフォルト 3                                                                                                                         |
| `GLITCHTIP_DSN`                       | -    | GlitchTip (エラートラッキング) の DSN。未設定なら送信しない                                                                                                                                                               |
| `CRAWL_WARNING_THRESHOLD`             | -    | 1 アカウントの crawl 1 回あたり、GlitchTip へ集約通知する warning 件数の閾値。デフォルト 5                                                                                                                                |
| `TWITTER_REQUEST_TIMEOUT_MS`          | -    | crawler が cycletls 経由の Twitter/X へ送る 1 リクエストに設ける Node 側の上限時間 (ミリ秒)。デフォルト 60000 (60 秒)。blocker やスクリプト実行 (`crawl-tweet.ts`) には適用されず、そちらは常にこのデフォルト値が使われる |
| `CRAWL_ACCOUNT_TIMEOUT_MS`            | -    | crawler の 1 account の crawl 処理 (外部通信フェーズ全体) に設ける上限時間 (ミリ秒)。デフォルト 3600000 (60 分)。ハング検出専用の保険であり、通常のアカウント処理時間を下回らないよう運用環境の実測値に応じて調整すること |
| `BLOCK_INTERVAL_SECONDS`              | -    | ブロック実行の間隔 (秒)。デフォルト 21600                                                                                                                                                                                 |
| `BLOCK_STALE_THRESHOLD_MULTIPLIER`    | -    | `running` のまま放置された BlockRun を検出するしきい値の倍率 (ブロック実行間隔の何倍か)。デフォルト 3                                                                                                                     |
| `BLOCK_ACTION_DELAY_MS`               | -    | 1 件ブロックするごとの待機時間 (ミリ秒)。デフォルト 2000                                                                                                                                                                  |
| `BLOCK_MAX_PER_ACCOUNT_PER_RUN`       | -    | 1 アカウント・1 サイクルあたりのブロック上限件数。デフォルト 50                                                                                                                                                           |
| `BLOCK_TARGET_NOT_FOUND_MAX_ATTEMPTS` | -    | code 50 (`BlockTargetNotFoundError`) を許容する最大試行回数 (初回を含む)。デフォルト 3                                                                                                                                    |
| `RELABELER_INTERVAL_SECONDS`          | -    | relabeler worker の実行間隔 (秒)。デフォルト 30                                                                                                                                                                           |
| `RELABELER_PRODUCER_BATCH_SIZE`       | -    | relabeler producer (stale scan) が 1 cycle あたりに scan する Account 件数。デフォルト 5000                                                                                                                               |
| `RELABELER_WORKER_BATCH_SIZE`         | -    | relabeler worker が 1 cycle あたりに claim する work item の上限件数 (concurrency 分の合計ではなく 1 レーンあたりの値)。デフォルト 2000                                                                                   |
| `RELABELER_WORKER_CONCURRENCY`        | -    | relabeler worker の evaluate フェーズの並行度。デフォルト 1                                                                                                                                                               |
| `RELABELER_WORKER_CHUNK_SIZE`         | -    | relabeler worker が follow-graph index を構築し claim/evaluate する際の 1 chunk あたりの account 件数。デフォルト 1000                                                                                                    |
| `RELABELER_LABEL_LOOKUP_CHUNK_SIZE`   | -    | relabeler producer の stale scan が AccountLabelLatest を lookup する際の 1 chunk あたりの account 件数。デフォルト 1000                                                                                                  |

## relabel backfill の運用契約

`relabeler` サービスは crawl とは独立して常駐し、`RELABELER_INTERVAL_SECONDS` (デフォルト 30 秒) ごとに stale scan と `account_relabel` キューの drain を行う。デフォルト設定 (batch size 現行維持・concurrency 1) では、新規/更新ラベル追加後の対象アカウント数が `RELABELER_WORKER_BATCH_SIZE` (デフォルト 2000) 件を大きく超えない範囲であれば数分〜数十分程度で `currentRuleVersion` coverage が収束する。対象が Account 全件規模 (約 247 万件) に及ぶ場合は、producer の `RELABELER_PRODUCER_BATCH_SIZE` による段階的な queued 化と drain 速度の両方に依存するため、より長い時間を要する。進捗は viewer の System 画面「Relabel backfill」セクションの coverage 表・backlog 表・scan cursor 更新時刻で確認できる。

**重要**: 本番機の `compose.prod.yaml` はこのリポジトリに含まれないため、このリポジトリの `compose.yaml` に追随して本番の compose 定義へ `relabeler` サービスを追加するまでは、本番へのデプロイと同時に relabel が一切実行されなくなる (`entrypoint.sh` からの `relabel-worker` 呼び出しを本 PR で削除したため)。crawler イメージの更新と `relabeler` サービス追加は同一デプロイで反映すること。

## recent tweets backfill の運用契約

recent tweets が未取得で対象ラベルを評価できなかったアカウントは、次の dry-run コマンドで確認する。dry-run がデフォルトであり、認証クライアントの作成や DB 更新は行わない。

```bash
pnpm --filter crawler run backfill:recent-tweets -- --limit 100 --dry-run
```

実際に取得・保存する構文は次のとおり。`<configured-account>` には `data/config.json` に設定済みの username を指定する。本番での実行には、この構文の記載とは別に明示的な承認が必要である。password、OTP secret、cookie などの認証情報をコマンドへ含めてはならない。

```bash
pnpm --filter crawler run backfill:recent-tweets -- --limit 100 --execute --username <configured-account>
```

## データ

- `data/config.json`: Twitter アカウントの認証情報 (git 管理外)
  - `block_enabled` (アカウントごと、省略時 `false`): このアカウントでブロック処理を実行するかどうか
  - `block_rule` (アカウントごと、任意): このアカウントに適用するブロックルール。`target_labels` はラベルごとの確信度閾値 (`label`・`confidence_threshold`) のリストで、対象ラベルは複数指定できる。省略時はトップレベルの `block` を使う
  - `block` (トップレベル、任意): 全アカウント共通のデフォルトブロックルール
  - `discord_webhook_url` (トップレベル、任意): ブロック結果を通知する Discord Webhook URL
- `data/postgres/`: Postgres の実データ (bind mount、git 管理外)
- `logs/`: クロールログ (実アカウント名を含むため git 管理外)
