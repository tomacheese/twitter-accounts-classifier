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
3. `docker compose up -d --build` で起動する。
4. 初回起動時に Prisma のマイグレーション・ラベル定義のシードが自動実行される。

## アクセス

| サービス | URL |
| --- | --- |
| Viewer (Web UI) | http://localhost:3000 |

## 環境変数

| 変数 | 必須 | 説明 |
| --- | --- | --- |
| `DATABASE_URL` | ○ | Postgres 接続文字列 |
| `COOKIE_ISSUER_URL` | ○ | cookie-issuer サービスの URL。フォールバック値はないため未設定だと起動時にエラーになる |
| `CRAWL_INTERVAL_SECONDS` | - | クロール間隔 (秒)。デフォルト 21600 (6時間) |
| `GLITCHTIP_DSN` | - | GlitchTip (エラートラッキング) の DSN。未設定なら送信しない |

## データ

- `data/config.json`: Twitter アカウントの認証情報 (git 管理外)
- `data/postgres/`: Postgres の実データ (bind mount、git 管理外)
- `logs/`: クロールログ (実アカウント名を含むため git 管理外)
