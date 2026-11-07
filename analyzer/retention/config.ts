/** 表ごとの保持日数。保持期限を変えるときはここだけを書き換える。 */
export const RETENTION_DAYS = {
  /** 完了台帳。冪等性 (同じ論理キーを再び積まない) の保持期間でもあるため、縮めない。 */
  analysisWorkItemDone: 30,
  /** リトライを使い切った dead の WorkItem。 */
  deadWorkItem: 30,
  analysisRun: 180,
  overviewSnapshot: 30,
  labelMetricSnapshot: 90,
  /** isShadow の行だけが対象。本番判定の行は削除しない。 */
  shadowDetectorEvaluation: 30,
  accountClassificationObservation: 30,
  /** 親の CrawlRun が終了 (または最後の heartbeat) してからの日数。 */
  crawlCheckpoint: 30,
  operationalIssueOccurrence: 180,
  reviewFindingOccurrence: 180,
} as const

/** 削除と孤児検査のバッチ設定。IO が逼迫したホストでも使えるよう、小さく区切って間を空ける。 */
export const MAINTENANCE_BATCH = {
  /** 1 文あたりの削除行数。 */
  deleteBatchSize: 5000,
  /** 1 回の sweep で表ごとに実行するバッチ数の上限。残りは次回に持ち越す。 */
  maxDeleteBatchesPerTable: 200,
  /** 孤児検査で 1 文が読む行数。 */
  orphanScanBatchSize: 20_000,
  /** バッチ間の待機時間。 */
  pauseMs: 100,
} as const
