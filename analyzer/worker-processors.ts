import path from 'node:path'
import type { AnalysisWorkItem, PrismaClient } from './generated/prisma'
import { enqueueWorkItem } from './queue/work-item-repository'
import { generateLabelMetricSnapshots } from './metrics/label-metric-snapshot'
import { generateFindingsForCrawlCycle } from './findings/generate-findings'
import {
  detectAnalysisStageFailure,
  detectRunFailures,
} from './operational-issues/detect-run-failures'
import { refreshReadModelFreshness } from './operational-issues/freshness'
import { parseIsoDurationMs } from './findings/lifecycle'
import { buildOrUpdateCrawlCycle } from './operations/build-crawl-cycle'
import { buildOrUpdateWeeklyReviewCycle } from './operations/build-weekly-review-cycle'
import { buildOrUpdateBlockCycle } from './operations/build-block-cycle'
import type { WorkItemOutcome } from './worker-loop'
import { publishGeneration } from './read-models/publish'
import { buildAccountSummary } from './read-models/build-account-summary'
import { buildLabelSummary } from './read-models/build-label-summary'
import { buildAttentionItems } from './read-models/build-attention-items'
import { buildOverviewSnapshot } from './read-models/build-overview-snapshot'
import { buildBlockRelationSummary } from './read-models/build-block-relation-summary'
import { ingestWeeklyReviewFindings } from './weekly-review/ingest'
import { runRetentionSweep } from './retention/sweep'
import { structuredOutputSchema } from './weekly-review/structured-output-schema'
import { loadPolicy } from './policy/load-policy'
import { computePolicyHash } from './policy/policy-hash'
import { Logger } from '@book000/node-utils'

const logger = Logger.configure('analyzer:worker-processors')

const APP_VERSION = process.env.APPLICATION_VERSION ?? 'unknown'
// CommonJS を採用する本プロジェクトでは __dirname がモジュールの位置を得る素直な手段であり、
// import.meta は tsconfig の module 設定と両立しない。
// eslint-disable-next-line unicorn/prefer-module
const POLICY_PATH = path.join(__dirname, 'policy/detection-policy.json')

let cachedPolicy: ReturnType<typeof loadPolicy> | undefined
let cachedPolicyHash: string | undefined

/**
 * detection-policy.json はプロセス起動中は変わらない前提で読み込みを 1 回に留める。
 * @returns 検証済み policy とその content hash
 */
function getPolicy(): { policy: ReturnType<typeof loadPolicy>; policyHash: string } {
  if (!cachedPolicy || !cachedPolicyHash) {
    cachedPolicy = loadPolicy(POLICY_PATH)
    cachedPolicyHash = computePolicyHash(cachedPolicy)
  }
  return { policy: cachedPolicy, policyHash: cachedPolicyHash }
}

/**
 * LabelMetricSnapshot を生成し、後続の finding_generation を enqueue する。
 * @param prisma - Prisma クライアント
 * @param workItem - `triggerType: 'crawl_run'` の WorkItem
 */
export async function processLabelMetrics(
  prisma: PrismaClient,
  workItem: AnalysisWorkItem,
): Promise<void> {
  const crawlRun = await prisma.crawlRun.findUniqueOrThrow({ where: { id: workItem.triggerId } })
  const { policyHash } = getPolicy()

  const result = await generateLabelMetricSnapshots(prisma, {
    crawlRunId: crawlRun.id,
    crawlRunStatus: crawlRun.status,
    sourceWatermarkAt: crawlRun.finishedAt ?? crawlRun.lastHeartbeatAt,
    policyHash,
    analyzerVersion: APP_VERSION,
  })

  // 一部の Label だけ欠けた metric set を後続へ渡すと、検出器がその Label の
  // 前回値と比較できないまま先へ進み、欠落が観測値の変化として残らなくなる。
  // WorkItem を失敗させて再試行に委ね、全 Label が揃うまで公開しない。
  if (result.failedLabelDefinitionIds.length > 0) {
    throw new Error(
      `label metric aggregation failed for ${result.failedLabelDefinitionIds.length}/${result.totalCount} labels: ${result.failedLabelDefinitionIds.join(', ')}`,
    )
  }

  await enqueueWorkItem(prisma, {
    kind: 'finding_generation',
    triggerType: 'crawl_run',
    triggerId: crawlRun.id,
  })
}

/**
 * ReviewFinding と OperationalIssue (run_failure) を評価し、
 * 後続の read_model_refresh を enqueue する。
 * @param prisma - Prisma クライアント
 * @param workItem - `triggerType: 'crawl_run'` の WorkItem
 */
export async function processFindingGeneration(
  prisma: PrismaClient,
  workItem: AnalysisWorkItem,
): Promise<void> {
  const crawlRun = await prisma.crawlRun.findUniqueOrThrow({ where: { id: workItem.triggerId } })
  const { policy, policyHash } = getPolicy()

  await detectRunFailures(prisma, {
    component: 'crawl',
    runId: crawlRun.id,
    runStatus: crawlRun.status,
    errorSummary: null,
    now: new Date(),
  })

  await generateFindingsForCrawlCycle(prisma, {
    crawlRunId: crawlRun.id,
    policy,
    policyHash,
    detectorVersion: APP_VERSION,
  })

  await enqueueWorkItem(prisma, {
    kind: 'read_model_refresh',
    triggerType: 'crawl_run',
    triggerId: crawlRun.id,
  })
}

/**
 * OperationalIssue と ReviewFinding の変化を Attention Queue と Overview へ波及させる。
 * Crawl 以外の契機で発生した Finding/Issue も同じ経路で可視化するため、
 * Weekly Review・Block 完了時からも同じ関数を呼ぶ。
 * @param prisma - Prisma クライアント
 * @param sourceWatermarkAt - 集計の基準時刻
 */
async function publishAttentionAndOverview(
  prisma: PrismaClient,
  sourceWatermarkAt: Date,
): Promise<void> {
  await publishGeneration(prisma, {
    modelKey: 'attention_items',
    schemaVersion: 1,
    sourceWatermarkAt,
    build: (generationId) => buildAttentionItems(prisma, { generationId, sourceWatermarkAt }),
  })
  await publishGeneration(prisma, {
    modelKey: 'overview_snapshot',
    schemaVersion: 1,
    sourceWatermarkAt,
    build: async (generationId) => {
      await buildOverviewSnapshot(prisma, { generationId, sourceWatermarkAt })
      return { rowCount: 1 }
    },
  })
}

/**
 * 読み取りモデル各種を原子的に再公開する。
 * OperationCycle は WorkItem の終了状態が確定した後でなければ最新の Stage 状態を
 * 反映できないため、ここではなく handleWorkItemSettled 側で再計算する。
 * @param prisma - Prisma クライアント
 * @param workItem - `triggerType: 'crawl_run'` の WorkItem
 */
export async function processReadModelRefresh(
  prisma: PrismaClient,
  workItem: AnalysisWorkItem,
): Promise<void> {
  const crawlRun = await prisma.crawlRun.findUniqueOrThrow({ where: { id: workItem.triggerId } })

  // 一部のアカウントしか巡回できなかった run の値を current として公開すると、
  // 巡回できなかった分の変化が観測されないまま最新状態として表示されてしまう。
  // この run の read model 公開は見送り、完全に巡回できた run の refresh に委ねる。
  if (crawlRun.status !== 'success') {
    logger.info(`skip read model refresh for crawl run ${crawlRun.id} (status: ${crawlRun.status})`)
    return
  }

  const sourceWatermarkAt = crawlRun.finishedAt ?? crawlRun.lastHeartbeatAt

  await publishGeneration(prisma, {
    modelKey: 'account_summary',
    schemaVersion: 1,
    sourceWatermarkAt,
    build: (generationId) =>
      buildAccountSummary(prisma, {
        generationId,
        sourceWatermarkAt,
        sourceCrawlRunId: crawlRun.id,
      }),
  })
  await publishGeneration(prisma, {
    modelKey: 'label_summary',
    schemaVersion: 1,
    sourceWatermarkAt,
    build: (generationId) => buildLabelSummary(prisma, { generationId, sourceWatermarkAt }),
  })
  await publishAttentionAndOverview(prisma, sourceWatermarkAt)
}

/**
 * WeeklyAnalysisRun の structuredOutput を検証・取り込む。
 * @param prisma - Prisma クライアント
 * @param workItem - `triggerType: 'weekly_analysis_run'` の WorkItem
 */
export async function processWeeklyReviewIngest(
  prisma: PrismaClient,
  workItem: AnalysisWorkItem,
): Promise<void> {
  const weeklyAnalysisRun = await prisma.weeklyAnalysisRun.findUniqueOrThrow({
    where: { id: workItem.triggerId },
  })

  await detectRunFailures(prisma, {
    component: 'weekly_review',
    runId: weeklyAnalysisRun.id,
    runStatus: weeklyAnalysisRun.status,
    errorSummary: weeklyAnalysisRun.errorMessage,
    now: new Date(),
  })

  // structuredOutput が無い run でも、失敗検知と Attention/Overview の更新までは
  // 済ませてから戻る。ここで即 return すると失敗した run が可視化されない。
  if (!weeklyAnalysisRun.structuredOutput) {
    await publishAttentionAndOverview(prisma, new Date())
    return
  }

  const parsed = structuredOutputSchema.safeParse(weeklyAnalysisRun.structuredOutput)
  if (!parsed.success) {
    throw new Error(
      `invalid structuredOutput for WeeklyAnalysisRun ${weeklyAnalysisRun.id}: ${parsed.error.message}`,
    )
  }

  const { policy } = getPolicy()
  await ingestWeeklyReviewFindings(prisma, {
    weeklyAnalysisRunId: weeklyAnalysisRun.id,
    structuredOutput: parsed.data,
    policy,
  })

  const sourceWatermarkAt = new Date()
  await publishGeneration(prisma, {
    modelKey: 'label_summary',
    schemaVersion: 1,
    sourceWatermarkAt,
    build: (generationId) => buildLabelSummary(prisma, { generationId, sourceWatermarkAt }),
  })
  await publishAttentionAndOverview(prisma, sourceWatermarkAt)
}

/**
 * BlockRun 完了を契機に BlockRelationCurrent を再公開する。
 * Block 自体の論理状態遷移は crawler 側の syncBlocks で fetch のたびに確定済みのため、
 * ここでは失敗検知と read model の再構築を担う。
 * @param prisma - Prisma クライアント
 * @param workItem - `triggerType: 'block_run'` の WorkItem
 */
export async function processBlockReconciliation(
  prisma: PrismaClient,
  workItem: AnalysisWorkItem,
): Promise<void> {
  const blockRun = await prisma.blockRun.findUniqueOrThrow({ where: { id: workItem.triggerId } })
  const sourceWatermarkAt = blockRun.finishedAt ?? blockRun.lastHeartbeatAt

  await detectRunFailures(prisma, {
    component: 'block',
    runId: blockRun.id,
    runStatus: blockRun.status,
    errorSummary: null,
    now: new Date(),
  })

  await publishGeneration(prisma, {
    modelKey: 'block_relation',
    schemaVersion: 1,
    sourceWatermarkAt,
    build: (generationId) => buildBlockRelationSummary(prisma, { generationId, sourceWatermarkAt }),
  })
  await publishAttentionAndOverview(prisma, sourceWatermarkAt)
}

const RETENTION_SWEEP_TRIGGER_TYPE = 'schedule'

/**
 * @param now - 基準時刻
 * @returns YYYY-MM-DD 形式の日付文字列
 */
function toDateKey(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/**
 * 起動ごとに毎回呼んでも、同じ日付の WorkItem は enqueueWorkItem の一意制約で
 * 1 度しか作られない。日付が変わった分だけ新しい WorkItem が積まれる。
 * @param prisma - Prisma クライアント
 * @param now - 基準時刻
 */
export async function enqueueDailyRetentionSweep(prisma: PrismaClient, now: Date): Promise<void> {
  await enqueueWorkItem(prisma, {
    kind: 'retention_sweep',
    triggerType: RETENTION_SWEEP_TRIGGER_TYPE,
    triggerId: toDateKey(now),
  })
}

/**
 * kind: retention_sweep の処理関数。古い履歴行を削除する。
 * 次回分の enqueue は `main()` が毎パスの起動時に当日分を冪等に行うため、
 * ここで翌日分を自己予約しない。`enqueueWorkItem` は `availableAt` を
 * 指定できず即時 claim 可能な行を作るため、ここから予約すると
 * queue が空にならないまま翌日分以降を連鎖して処理してしまう。
 * @param prisma - Prisma クライアント
 * @param workItem - `triggerType: 'schedule'` の WorkItem
 */
export async function processRetentionSweep(
  prisma: PrismaClient,
  workItem: AnalysisWorkItem,
): Promise<void> {
  const result = await runRetentionSweep(prisma, new Date())
  logger.info(
    `retention sweep (${workItem.triggerId}) removed ${result.deletedAnalysisRunCount} AnalysisRun, ` +
      `${result.deletedWorkItemCount} AnalysisWorkItem, ` +
      `${result.deletedLabelMetricSnapshotCount} LabelMetricSnapshot, ` +
      `${result.deletedOverviewSnapshotCount} OverviewSnapshot, ` +
      `${result.deletedShadowDetectorEvaluationCount} shadow DetectorEvaluation rows`,
  )
}

const DEFAULT_READ_MODEL_CADENCE = 'PT1H'
const DEFAULT_READ_MODEL_DELAYED_AFTER = 'PT3H'
const DEFAULT_READ_MODEL_STALE_AFTER = 'PT12H'

/**
 * 読み取りモデルの鮮度しきい値を policy から取り出して評価する。
 * WorkItem が完了した直後だけでなく、queue が空で何も処理しない
 * pass でも呼ぶことで、経過時間だけで delayed/stale へ落ちるようにする。
 * @param prisma - Prisma クライアント
 */
export async function refreshReadModelFreshnessFromPolicy(prisma: PrismaClient): Promise<void> {
  const { policy } = getPolicy()
  const rule = policy.rules.find((entry) => entry.type === 'read_model_freshness' && entry.enabled)
  if (!rule) return

  const delayedAfterMs = parseIsoDurationMs(rule.delayedAfter ?? DEFAULT_READ_MODEL_DELAYED_AFTER)
  await refreshReadModelFreshness(prisma, {
    cadenceMs: parseIsoDurationMs(DEFAULT_READ_MODEL_CADENCE),
    delayedAfterMs,
    staleAfterMs: parseIsoDurationMs(rule.staleAfter ?? DEFAULT_READ_MODEL_STALE_AFTER),
    now: new Date(),
  })
}

/**
 * WorkItem の終了状態が確定した後に、対応する OperationCycle を再計算し、
 * analyzer 自身の失敗を OperationalIssue へ昇格する。
 * @param prisma - Prisma クライアント
 * @param workItem - 終了した WorkItem
 * @param outcome - WorkItem の終了状態
 */
export async function handleWorkItemSettled(
  prisma: PrismaClient,
  workItem: AnalysisWorkItem,
  outcome: WorkItemOutcome,
): Promise<void> {
  await refreshReadModelFreshnessFromPolicy(prisma)

  await detectAnalysisStageFailure(prisma, {
    kind: workItem.kind,
    workItemId: workItem.id,
    attemptNumber: workItem.attemptCount,
    status: outcome.status,
    errorSummary: outcome.errorSummary,
    now: new Date(),
  })

  switch (workItem.triggerType) {
    case 'crawl_run': {
      await buildOrUpdateCrawlCycle(prisma, { crawlRunId: workItem.triggerId })
      break
    }
    case 'weekly_analysis_run': {
      await buildOrUpdateWeeklyReviewCycle(prisma, { weeklyAnalysisRunId: workItem.triggerId })
      break
    }
    case 'block_run': {
      await buildOrUpdateBlockCycle(prisma, { blockRunId: workItem.triggerId })
      break
    }
    default: {
      logger.warn(`no operation cycle builder for trigger type: ${workItem.triggerType}`)
    }
  }

  // processReadModelRefresh 等が publish する Attention/Overview は WorkItem を
  // succeeded/failed/dead にする前の状態で作られる。上の detectAnalysisStageFailure に
  // よる OperationalIssue の解消や Cycle の再構築はその後に確定するため、
  // ここで改めて publish しないと表示だけ古い状態のまま次の refresh まで残ってしまう。
  await publishAttentionAndOverview(prisma, new Date())
}
