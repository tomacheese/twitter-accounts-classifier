# Viewer 旧実装撤去計画

## 実行条件 (すべて満たしてから着手する)

- `VIEWER_NEW_UI_SECTIONS` に全区画を有効化した状態で、最低 2 週間の監視期間を経ている。
- 新画面の TTFB・HTML size・error rate が spec の性能予算・受け入れ基準を満たしている。
- 旧画面 (`/`, `/accounts` 旧実装, `/labels` 旧実装, `/weekly-runs`, `/crawl-runs`, `/block-runs`) へのアクセスがログ上ほぼ 0 になっている。
- 旧 Viewer への rollback 手順 (`VIEWER_NEW_UI_SECTIONS` を空にする) が release 前に実証済みである。

## 手順

1. 旧 `viewer/lib/queries/{dashboard,accounts,crawl-runs,block-runs,weekly-runs,system-status,attention-required,latest-crawl-summary,latest-block-summary}.ts` の利用箇所が新画面のみになっていることを確認する。
2. 旧ページコンポーネント (`viewer/app/crawl-runs`, `viewer/app/block-runs`, `viewer/app/weekly-runs` の非 redirect 実装、`viewer/app/components/dashboard-*`) を削除する PR を別途作成する。
3. 正本履歴テーブル (`CrawlRun` 等) 自体の列は削除しない。破壊的 migration (列削除) が必要な場合はさらに別 PR とし、利用箇所ゼロと rollback 手順を確認してから行う。
4. 削除 PR は本 Issue #65 の PR とは分離し、別 GitHub Issue を立てて追跡する。
