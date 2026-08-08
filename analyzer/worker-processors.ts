import path from 'node:path'
import type { AnalysisWorkItem, PrismaClient } from './generated/prisma'
import { enqueueWorkItem } from './queue/work-item-repository'
import { generateLabelMetricSnapshots } from './metrics/label-metric-snapshot'
import { generateFindingsForCrawlCycle } from './findings/generate-findings'
import { detectRunFailures } from './operational-issues/detect-run-failures'
import { buildOrUpdateCrawlCycle } from './operations/build-crawl-cycle'
import { publishGeneration } from './read-models/publish'
import { buildAccountSummary } from './read-models/build-account-summary'
import { buildLabelSummary } from './read-models/build-label-summary'
import { buildAttentionItems } from './read-models/build-attention-items'
import { buildOverviewSnapshot } from './read-models/build-overview-snapshot'
import { buildBlockRelationSummary } from './read-models/build-block-relation-summary'
import { ingestWeeklyReviewFindings } from './weekly-review/ingest'
import { structuredOutputSchema } from './weekly-review/structured-output-schema'
import { loadPolicy } from './policy/load-policy'
import { computePolicyHash } from './policy/policy-hash'

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

  await generateLabelMetricSnapshots(prisma, {
    crawlRunId: crawlRun.id,
    sourceWatermarkAt: crawlRun.finishedAt ?? crawlRun.lastHeartbeatAt,
    policyHash,
    analyzerVersion: APP_VERSION,
  })

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
 * OperationCycle を更新し、読み取りモデル各種を原子的に再公開する。
 * @param prisma - Prisma クライアント
 * @param workItem - `triggerType: 'crawl_run'` の WorkItem
 */
export async function processReadModelRefresh(
  prisma: PrismaClient,
  workItem: AnalysisWorkItem,
): Promise<void> {
  const crawlRun = await prisma.crawlRun.findUniqueOrThrow({ where: { id: workItem.triggerId } })
  const sourceWatermarkAt = crawlRun.finishedAt ?? crawlRun.lastHeartbeatAt

  await buildOrUpdateCrawlCycle(prisma, { crawlRunId: crawlRun.id })

  await publishGeneration(prisma, {
    modelKey: 'account_summary',
    schemaVersion: 1,
    sourceWatermarkAt,
    build: (generationId) => buildAccountSummary(prisma, { generationId, sourceWatermarkAt }),
  })
  await publishGeneration(prisma, {
    modelKey: 'label_summary',
    schemaVersion: 1,
    sourceWatermarkAt,
    build: (generationId) => buildLabelSummary(prisma, { generationId, sourceWatermarkAt }),
  })
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
  if (!weeklyAnalysisRun.structuredOutput) return

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
}

/**
 * BlockRun 完了を契機に BlockRelationCurrent を再公開する。
 * Block 自体の論理状態遷移は crawler 側の syncBlocks で fetch のたびに確定済みのため、
 * ここでは read model の再構築のみを担う。
 * @param prisma - Prisma クライアント
 * @param workItem - `triggerType: 'block_run'` の WorkItem
 */
export async function processBlockReconciliation(
  prisma: PrismaClient,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _workItem: AnalysisWorkItem,
): Promise<void> {
  const sourceWatermarkAt = new Date()

  await publishGeneration(prisma, {
    modelKey: 'block_relation',
    schemaVersion: 1,
    sourceWatermarkAt,
    build: (generationId) => buildBlockRelationSummary(prisma, { generationId, sourceWatermarkAt }),
  })
}
