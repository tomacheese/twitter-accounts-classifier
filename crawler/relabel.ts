import { Logger } from '@book000/node-utils'
import { captureException, initMonitoring } from './monitoring/sentry'
import type { PrismaClient } from './generated/prisma'
import { getPrismaClient, disconnectPrisma } from './db/client'
import { ensureLabelDefinitionsForRules } from './db/label-repository'
import { refreshLabelAggregate } from './db/label-aggregate-repository'
import { LabelRuleRegistry } from './labels/registry'
import { ALL_LABEL_RULES } from './labels/all-rules'
import { scanForStaleAccounts } from './relabel-worker'

const logger = Logger.configure('relabel')

// 1 ページあたりの scan 件数。rule 評価はここでは行わず enqueue のみのため、
// relabel-worker.ts の producer と同じ値で問題ない。
const MANUAL_SCAN_BATCH_SIZE = 5000

export interface RelabelResult {
  accountsScanned: number
  accountsRequested: number
}

/**
 * 通常運用は crawler/relabel-worker.ts の producer が entrypoint loop の周期ごとに incremental に進める。
 * 新規ルール追加直後などに今すぐ全件を re-scan して account_relabel を要求したい場合の手動 CLI (`pnpm relabel`) 向けエントリポイントとして用意する。
 * rule 評価・label 永続化はここでは行わず、stale な account の enqueue だけを行う。
 * 評価・永続化は relabel-worker.ts の drainAccountRelabelQueue (entrypoint loop 経由) が担う。
 * @param prisma - 使用する Prisma クライアント
 * @param registry - stale 判定に使うラベルルールのレジストリ
 * @returns scan した account の総数と account_relabel を要求した総数
 */
export async function runRelabelBackfill(
  prisma: PrismaClient,
  registry: LabelRuleRegistry,
): Promise<RelabelResult> {
  const labelDefinitionIds = await ensureLabelDefinitionsForRules(prisma, registry.getAll())

  let accountsScanned = 0
  let accountsRequested = 0
  for (;;) {
    const { scanned, requested, wrapped } = await scanForStaleAccounts(prisma, {
      registry,
      labelDefinitionIds,
      batchSize: MANUAL_SCAN_BATCH_SIZE,
    })
    accountsScanned += scanned
    accountsRequested += requested
    logger.info(`Relabel scan progress: ${accountsScanned} scanned, ${accountsRequested} requested`)
    // scanned === 0 はテーブルが空、wrapped は先頭まで一巡し終えたことを示す。
    if (scanned === 0 || wrapped) break
  }

  return { accountsScanned, accountsRequested }
}

async function main(): Promise<void> {
  const prisma = getPrismaClient()
  const registry = new LabelRuleRegistry()
  for (const rule of ALL_LABEL_RULES) {
    registry.register(rule)
  }

  try {
    const { accountsScanned, accountsRequested } = await runRelabelBackfill(prisma, registry)
    logger.info(
      `Relabel backfill request complete: ${accountsScanned} accounts scanned, ${accountsRequested} requested for reclassification`,
    )
    try {
      await refreshLabelAggregate(prisma)
    } catch (error) {
      logger.error('Failed to refresh label aggregate:', error as Error)
      captureException(error, { source: 'relabel.refreshLabelAggregate' })
    }
  } finally {
    await disconnectPrisma()
  }
}

// このモジュールを import しただけでは実際のバックフィルが走らないようにするガード。
// 直接実行 (`node dist/relabel.js`)した場合のみ動作する。require/module は、
// CommonJS を採用する本プロジェクトでこれを判定するのに適した手段である。
// eslint-disable-next-line unicorn/prefer-module
if (require.main === module) {
  initMonitoring()
  main().catch((error: unknown) => {
    logger.error('Relabel backfill failed', error as Error)
    captureException(error)
    process.exitCode = 1
  })
}
