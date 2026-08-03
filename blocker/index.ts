import { Logger } from '@book000/node-utils'
import { createCookieIssuerClient, createOpenApiClient, closeOpenApiClient } from 'twitter-client'
import type { PrismaClient } from './generated/prisma'
import { getPrismaClient, disconnectPrisma } from './db/client'
import {
  loadBlockerConfig,
  type BlockerAppConfig,
  type BlockerAccountConfig,
} from './config/load-config'
import { loadBlockLimits } from './config/block-limits'
import { getCookieIssuerBaseUrl } from './config/env'
import {
  startBlockRun,
  finishBlockRun,
  touchBlockRunHeartbeat,
  recordBlockAction,
  startBlockAccountRun,
  finishBlockAccountRun,
} from './db/block-run-repository'
import { selectBlockCandidates } from './db/candidate-repository'
import { recordSuccessfulBlock } from './db/block-repository'
import { runBlockAccountCycle } from './block-cycle'
import { notifyDiscord, type AccountRunSummary } from './discord-notifier'
import { initMonitoring, captureException } from './monitoring/sentry'

const logger = Logger.configure('blocker')

export interface RunBlockCycleDependencies {
  config: BlockerAppConfig
  prisma: PrismaClient
  startBlockRun: typeof startBlockRun
  finishBlockRun: typeof finishBlockRun
  touchBlockRunHeartbeat: typeof touchBlockRunHeartbeat
  runBlockAccountCycle: typeof runBlockAccountCycle
  notifyDiscord: typeof notifyDiscord
}

/**
 * `block_enabled` な全アカウントについて順番にブロックサイクルを実行し、
 * 完了後に 1 通の Discord 通知を送る。
 * 1 アカウントの処理が例外を投げても、他アカウントの処理は継続する
 * (`crawl.ts` の各アカウントループと同じ考え方)。
 * @param deps - このサイクルに必要な依存関数一式
 */
export async function runBlockCycle(deps: RunBlockCycleDependencies): Promise<void> {
  const startedAt = new Date()
  const run = await deps.startBlockRun(deps.prisma, startedAt)
  const summaries: AccountRunSummary[] = []
  const targetAccounts = deps.config.accounts.filter(
    (account): account is BlockerAccountConfig => account.blockEnabled,
  )

  for (const account of targetAccounts) {
    await deps.touchBlockRunHeartbeat(deps.prisma, run.id, new Date())
    try {
      const summary = await deps.runBlockAccountCycle(
        {
          issueCookies: (issuedAccount) =>
            createCookieIssuerClient({ baseUrl: getCookieIssuerBaseUrl() }).issueCookiesWithRetry(
              issuedAccount,
            ),
          createOpenApiClient,
          closeOpenApiClient,
          selectBlockCandidates,
          recordSuccessfulBlock,
          startBlockAccountRun,
          finishBlockAccountRun,
          recordBlockAction,
          prisma: deps.prisma,
          limits: loadBlockLimits(),
        },
        account,
        deps.config,
        run.id,
      )
      summaries.push(summary)
    } catch (error) {
      logger.error(
        `Unexpected failure while running block cycle for ${account.username}`,
        error as Error,
      )
      captureException(error, { username: account.username })
      summaries.push({ username: account.username, blockedCount: 0, failedCount: 0 })
    }
  }

  await deps.notifyDiscord(deps.config.discordWebhookUrl, summaries)
  await deps.finishBlockRun(deps.prisma, run.id, new Date(), 'completed')
}

async function main(): Promise<void> {
  const prisma = getPrismaClient()
  try {
    const config = loadBlockerConfig()
    await runBlockCycle({
      config,
      prisma,
      startBlockRun,
      finishBlockRun,
      touchBlockRunHeartbeat,
      runBlockAccountCycle,
      notifyDiscord,
    })
  } finally {
    await disconnectPrisma()
  }
}

// このモジュールを import しただけでは実際のブロックサイクルが走らないようにするガード。
// 直接実行 (`node dist/index.js`) した場合のみ動作する。require/module は、
// CommonJS を採用する本プロジェクトでこれを判定するのに適した手段である。
// eslint-disable-next-line unicorn/prefer-module
if (require.main === module) {
  initMonitoring()
  main().catch((error: unknown) => {
    logger.error('Block cycle failed', error as Error)
    captureException(error)
    process.exitCode = 1
  })
}
