# AGENTS.md

Twitter/X をクロールして収集したツイート・アカウント情報から、青バッジ/スパム/トピックなどのラベルを自動付与するプロジェクトのリポジトリ規約。設計背景は [README.md](./README.md) と [SPEC.md](./SPEC.md) を参照する。

## 言語規約

- コミットメッセージの説明部、PR/Issue のタイトルと本文、コードコメント・docstring、ドキュメント (Markdown) は日本語で書く。
- 日本語と英数字の間には半角スペースを入れる。
- 例外: 識別子、ログ出力、エラーメッセージ (英語)、利用者向けの通知・UI 文言、日本語のデータパターンや fixture、引用、`package.json` (英語)。
- コミットは Conventional Commits、ブランチは Conventional Branch (`feat/...`、`fix/...` など) に従う。

## 構成

pnpm workspace (`pnpm-workspace.yaml`) と、各パッケージが共有する Prisma スキーマ (`prisma/schema.prisma`) からなる。スキーマはリポジトリルート直下に置き、各パッケージからは `--schema=../prisma/schema.prisma` で相対参照する。

- `crawler/`: タイムライン・ツイート・プロフィールを収集し、`crawler/labels/rules/` のルール群でラベリングして Postgres に保存する。relabeler (`relabel.ts`、`relabel-worker.ts`) も含む
- `blocker/`: ラベルと確信度のしきい値に基づいてブロックを実行する
- `analyzer/`: 収集結果の read model 更新、検出器による Finding 生成、週次レビュー向けの集計を行う
- `viewer/`: 収集結果を表示する Next.js アプリ
- `twitter-client/`: Twitter/X への通信クライアント
- `pipeline-health/`: パイプラインの健全性判定ロジック (viewer がビルド時に利用する)
- `scripts/`・`ops/`: 運用スクリプト (DB ロール同期、storage guard、週次分析の起動など)

実行形態は `compose.yaml` を参照する。

## 開発コマンド

Node.js 24 (各パッケージの `.node-version`) と、`package.json` の `packageManager` で固定された pnpm を使う。各パッケージで次のスクリプトを実行できる (`twitter-client`・`pipeline-health` を除き `precheck` で Prisma Client を生成する)。

| コマンド | 内容 |
| --- | --- |
| `pnpm lint` | ESLint (`@book000/eslint-config`) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest |
| `pnpm format` | Prettier (`--check`) |
| `pnpm check` | lint・typecheck・test を並列実行 |

変更したパッケージで `pnpm check` と `pnpm format` が通ることを確認してからコミットする。リポジトリルートからは `pnpm --filter <パッケージ名> run <script>` で実行する。CI は `.github/workflows/nodejs-ci.yml` を参照する。

Prettier はセミコロンなし・シングルクォート・`trailingComma: all`・`printWidth: 100`。手で整形せず `prettier --write` に任せる。

## 最重要ルール: 実在する Twitter/X のデータをリポジトリに残さない

このプロジェクトは実在アカウントのクロール結果を扱うため、開発中に実データがソースコードへ紛れ込みやすい。**実在する、特定可能な Twitter/X のデータを、ソースコードのコメント・テスト fixture・ドキュメントに書かないこと。**

禁止対象には次のものが含まれる。クロール結果や実際に観測したアカウントからコピーしたものは、一部であっても該当する。

- 実在するスクリーンネーム / ハンドル (`@` 付きかどうかを問わない)
- 実在する表示名
- 実在するツイート / ポストの本文
- 実在するプロフィール文 (bio)
- 実在するプロフィール URL やアカウント URL
- 実在する `t.co` リンク、およびその他の実在する短縮 URL

### 代わりに架空の値を使う

検出ルールの意図をコメントで説明する場合やテストに例示データが必要な場合は、明らかに架空とわかるプレースホルダーを使う。

- ハンドル: `alice`、`bob`、`test_user` のような汎用的なもの
- bio・ツイート本文: 実在の投稿を思わせない、こちらで創作した文章
- URL: 形だけ揃えた架空のもの (例: `https://t.co/exampleXXXX`)

置き換えるときは、そのコメントやテストが示そうとしている性質 (言語、文字数、キーワードの出現パターン、しきい値との大小関係、ルールがマッチすべきかどうか) を保ち、実在アカウントに辿り着けない値にする。デバッグ中の一時的な貼り付けも、コミット前に必ず架空の値へ置き換える。

実データを含む `data/`・`logs/` は `.gitignore` で除外しているが、これはファイル単位の防御にすぎず、コメントや fixture に直接書かれた値は防げない。

## コードコメントの規約

1. 日本語で統一する。英語や日英混在のコメントを書かない。
2. GitHub Issue 番号、spec ファイル、plan ファイルへの言及を書かない。
3. 文中で不用意に改行しない。改行するとしても「、」「。」の直後に限る。1 行に収まらない場合は改行位置を探すのではなく、一文自体を短くする。
4. 「なぜ別の実装・しきい値・アプローチを採らなかったか (why not)」の結論のみを書く。コードの挙動をそのまま説明する記載や、結論を裏付ける実験件数・比率・検証手順などの経過情報は書かない。

JSDoc の `@param`/`@returns` など型・引数を機械的に説明する箇所は 1〜3 の対象とし、4 は適用しない。URL のみを提示する行は対象外とするが、Issue・spec・plan への言及があれば除去する。

## ラベリングルールとマイグレーション

- `crawler/labels/rules/` の各ルールは、実装ファイルと同名の `.test.ts` を必ず持つ。ルールを追加・変更する際は、マッチすべきケースとマッチすべきでないケースの両方 (特に部分一致による誤検出を防ぐ境界ケース) をテストする。
- `crawler/labels/rules/` のテストデータ、検出ポリシー (`analyzer/policy/detection-policy.json`)、ラベル定義のシードは挙動そのものである。意図的な変更でない限り書き換えない。
- `prisma/migrations/` の適用済みマイグレーションは編集しない (チェックサムが変わるため)。変更は新しいマイグレーションで行う。
- viewer は認証機構を持たず、フォロー・フォロワー・ブロック一覧を含む収集データを誰でも閲覧できる。信頼できるネットワーク内からのみ利用する前提であり、`compose.yaml` の既存のポートマッピング (`3000:3000`) を超えて公開範囲を広げる変更をしない。
- `data/config.json` (認証情報)、`.env*`、`data/`、`logs/` はコミットしない。
