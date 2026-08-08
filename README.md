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

| サービス | URL |
| --- | --- |
| Viewer (Web UI) | http://localhost:3000 |

Viewer には認証機構がなく、フォロー・フォロワー・ブロック一覧を含む収集データを誰でも閲覧できる。信頼できるネットワーク内 (開発機・本番機分離構成の内側) からのみアクセスできる前提であり、インターネットに直接公開しないこと。

## 環境変数

| 変数 | 必須 | 説明 |
| --- | --- | --- |
| `DATABASE_URL` | ○ | Postgres 接続文字列 |
| `COOKIE_ISSUER_URL` | ○ | cookie-issuer サービスの URL。フォールバック値はないため未設定だと起動時にエラーになる |
| `CRAWL_INTERVAL_SECONDS` | - | クロール間隔 (秒)。デフォルト 21600 (6時間) |
| `CRAWL_STALE_THRESHOLD_MULTIPLIER` | - | `running` のまま放置された CrawlRun を検出するしきい値の倍率 (クロール間隔の何倍か)。デフォルト 3 |
| `GLITCHTIP_DSN` | - | GlitchTip (エラートラッキング) の DSN。未設定なら送信しない |
| `CRAWL_WARNING_THRESHOLD` | - | 1 アカウントの crawl 1 回あたり、GlitchTip へ集約通知する warning 件数の閾値。デフォルト 5 |
| `BLOCK_INTERVAL_SECONDS` | - | ブロック実行の間隔 (秒)。デフォルト 21600 |
| `BLOCK_STALE_THRESHOLD_MULTIPLIER` | - | `running` のまま放置された BlockRun を検出するしきい値の倍率 (ブロック実行間隔の何倍か)。デフォルト 3 |
| `BLOCK_ACTION_DELAY_MS` | - | 1 件ブロックするごとの待機時間 (ミリ秒)。デフォルト 2000 |
| `BLOCK_MAX_PER_ACCOUNT_PER_RUN` | - | 1 アカウント・1 サイクルあたりのブロック上限件数。デフォルト 50 |

## データ

- `data/config.json`: Twitter アカウントの認証情報 (git 管理外)
  - `block_enabled` (アカウントごと、省略時 `false`): このアカウントでブロック処理を実行するかどうか
  - `block_rule` (アカウントごと、任意): このアカウントに適用するブロックルール。`target_labels` はラベルごとの確信度閾値 (`label`・`confidence_threshold`) のリストで、対象ラベルは複数指定できる。省略時はトップレベルの `block` を使う
  - `block` (トップレベル、任意): 全アカウント共通のデフォルトブロックルール
  - `discord_webhook_url` (トップレベル、任意): ブロック結果を通知する Discord Webhook URL
- `data/postgres/`: Postgres の実データ (bind mount、git 管理外)
- `logs/`: クロールログ (実アカウント名を含むため git 管理外)
