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
import {
  findActiveFindingsAtWatermarkForAccount,
  findLabelsAtWatermarkForAccount,
  findPreviousLabelAtWatermarkForAccount,
} from './read-models/build-account-summary-latest-row'
import {
  markAccountSummaryLatestFailed,
  touchAccountSummaryLatestState,
  upsertAccountClassificationLatest,
  upsertAccountSummaryLatest,
} from './read-models/account-summary-latest'

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
    // AccountSummary が使う sourceWatermarkAt (processReadModelRefresh 側) と
    // 同じ値を使うことで、この crawl から生成された Occurrence が
    // 同じ crawl の AccountSummary から漏れないようにする。
    sourceObservedAt: crawlRun.finishedAt ?? crawlRun.lastHeartbeatAt,
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
 * @param a - 比較対象の severity (null は severity なし扱い)
 * @param b - 比較対象の severity
 * @returns より深刻な方の severity
 */
function maxAccountFindingSeverity(a: string | null, b: string): string {
  const rank: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 }
  if (!a) return b
  return (rank[a] ?? 0) >= (rank[b] ?? 0) ? a : b
}

/**
 * 2 つのラベルキー集合が要素単位で一致するか判定する。
 * 件数だけの比較では、同じ件数のまま中身が入れ替わる変化 (A→B) を見逃すため、
 * `lastClassificationChangedAt` の判定にはこちらを使う。
 * @param a - 比較対象のラベルキー集合
 * @param b - 比較対象のラベルキー集合
 * @returns 集合として一致していれば true
 */
function isSameLabelKeySet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = a.toSorted()
  const sortedB = b.toSorted()
  return sortedA.every((key, index) => key === sortedB[index])
}

/**
 * author 単位の classification observation を契機に、対象 1 Account だけを
 * `AccountSummaryLatest`/`AccountClassificationLatest` へ反映する。
 * finding 系フィールド (activeFindingCount/highestFindingSeverity/findingObservedAt) は
 * ここでは更新しない (現状値をそのまま渡す)。
 * `AccountLabelChange` は `AccountLabel` 履歴上の直前行との比較 (既存の
 * `buildAccountSummary` と同じロジック) で判定し、`AccountClassificationLatest` の
 * 前回値には依存しない (並行更新の順序に依存させないため)。
 * @param prisma - Prisma クライアント
 * @param workItem - `triggerType: 'account_classification_observation'` の WorkItem
 */
export async function processAccountSummaryRefresh(
  prisma: PrismaClient,
  workItem: AnalysisWorkItem,
): Promise<void> {
  try {
    const observation = await prisma.accountClassificationObservation.findUniqueOrThrow({
      where: { id: workItem.triggerId },
    })
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: observation.accountId },
    })
    const [labels, previousLabels, existing] = await Promise.all([
      findLabelsAtWatermarkForAccount(prisma, observation.accountId, observation.observedAt),
      findPreviousLabelAtWatermarkForAccount(prisma, observation.accountId, observation.observedAt),
      prisma.accountSummaryLatest.findUnique({ where: { accountId: observation.accountId } }),
    ])
    const previousByLabelDefinitionId = new Map(
      previousLabels.map((label) => [label.labelDefinitionId, label]),
    )
    const labelDefinitions = await prisma.labelDefinition.findMany({
      select: { id: true, key: true },
    })
    const labelKeyById = new Map(
      labelDefinitions.map((definition) => [definition.id, definition.key]),
    )

    const activeLabelKeys = labels
      .filter((label) => label.value)
      .map((label) => labelKeyById.get(label.labelDefinitionId))
      .filter((key): key is string => key !== undefined)
    const changed = existing
      ? !isSameLabelKeySet(existing.activeLabelKeys, activeLabelKeys)
      : activeLabelKeys.length > 0

    await prisma.$transaction(async (tx) => {
      await upsertAccountSummaryLatest(tx as unknown as PrismaClient, {
        accountId: observation.accountId,
        normalizedScreenName: account.screenName.toLowerCase(),
        normalizedDisplayName: account.displayName.toLowerCase(),
        searchDocument: `${account.screenName} ${account.displayName}`.toLowerCase(),
        // profileObservedAt には Account の実際のプロフィール取得時刻 (lastCrawledAt) を使う。
        // classification observation の時刻を流用すると、プロフィールを再取得していない
        // refresh でも profile が最新化されたかのように見えてしまう。
        profileObservedAt: account.lastCrawledAt,
        activeLabelKeys,
        activeLabelCount: activeLabelKeys.length,
        lastClassificationChangedAt: changed
          ? observation.observedAt
          : (existing?.lastClassificationChangedAt ?? null),
        classificationObservedAt: observation.observedAt,
        activeFindingCount: existing?.activeFindingCount ?? 0,
        highestFindingSeverity: existing?.highestFindingSeverity ?? null,
        findingObservedAt: existing?.findingObservedAt ?? null,
      })
      await upsertAccountClassificationLatest(
        tx as unknown as PrismaClient,
        labels.map((label) => ({
          accountId: label.accountId,
          labelDefinitionId: label.labelDefinitionId,
          value: label.value,
          confidence: label.confidence,
          reason: label.reason,
          method: label.method,
          ruleVersion: label.ruleVersion,
          observedAt: observation.observedAt,
          sourceObservationId: observation.id,
        })),
      )

      for (const label of labels) {
        const previous = previousByLabelDefinitionId.get(label.labelDefinitionId)
        let changeType: string | undefined
        if (previous === undefined) {
          if (label.value) changeType = 'added'
        } else if (previous.value !== label.value) {
          changeType = label.value ? 'added' : 'removed'
        } else if (previous.confidence !== label.confidence || previous.reason !== label.reason) {
          changeType = 'updated'
        }
        if (!changeType) continue

        await (tx as unknown as PrismaClient).accountLabelChange.upsert({
          where: {
            accountId_labelDefinitionId_changedAt: {
              accountId: label.accountId,
              labelDefinitionId: label.labelDefinitionId,
              changedAt: label.labeledAt,
            },
          },
          create: {
            accountId: label.accountId,
            labelDefinitionId: label.labelDefinitionId,
            changeType,
            previousValue: previous?.value ?? null,
            newValue: label.value,
            previousConfidence: previous?.confidence ?? null,
            newConfidence: label.confidence,
            previousReason: previous?.reason ?? null,
            newReason: label.reason,
            sourceId: observation.crawlRunId,
            changedAt: label.labeledAt,
          },
          update: {},
        })
      }
    })

    await touchAccountSummaryLatestState(prisma, observation.observedAt)
  } catch (error) {
    await markAccountSummaryLatestFailed(prisma, String(error))
    throw error
  }
}

/**
 * Weekly Review の finding 取り込み・crawl 由来の finding 生成が確定させた
 * ReviewFindingOccurrence を契機に、対象 1 Account の finding 系フィールドだけを更新する。
 * @param prisma - Prisma クライアント
 * @param workItem - `triggerType: 'review_finding_occurrence'` の WorkItem
 */
export async function processAccountFindingRefresh(
  prisma: PrismaClient,
  workItem: AnalysisWorkItem,
): Promise<void> {
  try {
    const occurrence = await prisma.reviewFindingOccurrence.findUniqueOrThrow({
      where: { id: workItem.triggerId },
      include: { finding: true },
    })
    if (occurrence.finding.primaryScopeType !== 'account') return
    const accountId = occurrence.finding.primaryScopeId
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } })
    const [activeFindings, existing] = await Promise.all([
      findActiveFindingsAtWatermarkForAccount(prisma, accountId, occurrence.sourceObservedAt),
      prisma.accountSummaryLatest.findUnique({ where: { accountId } }),
    ])

    let highestFindingSeverity: string | null = null
    for (const finding of activeFindings) {
      highestFindingSeverity = maxAccountFindingSeverity(highestFindingSeverity, finding.severity)
    }

    await upsertAccountSummaryLatest(prisma, {
      accountId,
      normalizedScreenName: existing?.normalizedScreenName ?? account.screenName.toLowerCase(),
      normalizedDisplayName: existing?.normalizedDisplayName ?? account.displayName.toLowerCase(),
      searchDocument:
        existing?.searchDocument ?? `${account.screenName} ${account.displayName}`.toLowerCase(),
      profileObservedAt: existing?.profileObservedAt ?? account.lastCrawledAt,
      activeLabelKeys: existing?.activeLabelKeys ?? [],
      activeLabelCount: existing?.activeLabelCount ?? 0,
      lastClassificationChangedAt: existing?.lastClassificationChangedAt ?? null,
      classificationObservedAt: existing?.classificationObservedAt ?? null,
      activeFindingCount: activeFindings.length,
      highestFindingSeverity,
      findingObservedAt: occurrence.sourceObservedAt,
    })
    await touchAccountSummaryLatestState(prisma, occurrence.sourceObservedAt)
  } catch (error) {
    await markAccountSummaryLatestFailed(prisma, String(error))
    throw error
  }
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
    // Task 13 で processLabelAggregateRefresh からの呼び出しへ差し替えるまでの
    // 暫定値。この経路は既に旧 snapshot 生成が壊れているため実行時には到達しない。
    build: (generationId) =>
      buildLabelSummary(prisma, {
        generationId,
        triggerWorkItemId: crawlRun.id,
        sourceWatermarkAt,
      }),
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
    // AccountSummary が primaryScopeType: 'account' の Occurrence を watermark と
    // 比較する際、analyzer の処理時刻ではなく元データの時刻を使えるようにする。
    sourceObservedAt: weeklyAnalysisRun.finishedAt ?? weeklyAnalysisRun.lastHeartbeatAt,
  })

  const sourceWatermarkAt = new Date()
  await publishGeneration(prisma, {
    modelKey: 'label_summary',
    schemaVersion: 1,
    sourceWatermarkAt,
    // Task 13 で processLabelAggregateRefresh からの呼び出しへ差し替えるまでの
    // 暫定値。この経路は既に旧 snapshot 生成が壊れているため実行時には到達しない。
    build: (generationId) =>
      buildLabelSummary(prisma, {
        generationId,
        triggerWorkItemId: weeklyAnalysisRun.id,
        sourceWatermarkAt,
      }),
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

/**
 * kind: post_completion_refresh の処理関数。
 * handleWorkItemSettled が例外を投げて non-durable な post-completion hook として
 * 終わった場合の再試行を担う。元 WorkItem は既に succeeded/failed/dead で確定済みのため、
 * その行を再読み込みして終了状態を復元し、同じ後処理をやり直す。
 * @param prisma - Prisma クライアント
 * @param workItem - triggerId に元 WorkItem の ID を持つ post_completion_refresh の WorkItem
 */
export async function processPostCompletionRefresh(
  prisma: PrismaClient,
  workItem: AnalysisWorkItem,
): Promise<void> {
  const originalWorkItem = await prisma.analysisWorkItem.findUniqueOrThrow({
    where: { id: workItem.triggerId },
  })
  const outcome: WorkItemOutcome = {
    status: originalWorkItem.status as WorkItemOutcome['status'],
    errorSummary: originalWorkItem.lastErrorSummary ?? undefined,
  }
  await handleWorkItemSettled(prisma, originalWorkItem, outcome)
}
