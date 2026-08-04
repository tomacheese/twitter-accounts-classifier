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
import {
  getCookieIssuerBaseUrl,
  getBlockIntervalSeconds,
  getBlockStaleThresholdMultiplier,
} from './config/env'
import {
  startOrResumeBlockRun,
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
  startOrResumeBlockRun: typeof startOrResumeBlockRun
  finishBlockRun: typeof finishBlockRun
  touchBlockRunHeartbeat: typeof touchBlockRunHeartbeat
  runBlockAccountCycle: typeof runBlockAccountCycle
  notifyDiscord: typeof notifyDiscord
}

/**
 * 1 アカウントの処理が例外を投げても、他アカウントの処理は継続する
 * (`crawl.ts` の各アカウントループと同じ考え方)。
 * いずれかのアカウントが失敗した場合は `BlockRun` 自体の status も `'failed'` にする:
 * 個々の `BlockAccountRun` にしか失敗が残らないと、放置しても誰も気付けない。
 * @param deps - このサイクルに必要な依存関数一式
 */
export async function runBlockCycle(deps: RunBlockCycleDependencies): Promise<void> {
  const startedAt = new Date()
  const staleThresholdMs = getBlockIntervalSeconds() * getBlockStaleThresholdMultiplier() * 1000
  const run = await deps.startOrResumeBlockRun(deps.prisma, startedAt, staleThresholdMs)
  const summaries: AccountRunSummary[] = []
  const targetAccounts = deps.config.accounts.filter(
    (account): account is Extract<BlockerAccountConfig, { blockEnabled: true }> =>
      account.blockEnabled,
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
        run.id,
      )
      summaries.push(summary)
    } catch (error) {
      logger.error(
        `Unexpected failure while running block cycle for ${account.username}`,
        error as Error,
      )
      captureException(error, { username: account.username })
      summaries.push({ username: account.username, blockedCount: 0, failedCount: 0, failed: true })
    }
  }

  await deps.notifyDiscord(deps.config.discordWebhookUrl, summaries)
  const runStatus = summaries.some((summary) => summary.failed) ? 'failed' : 'completed'
  await deps.finishBlockRun(deps.prisma, run.id, new Date(), runStatus)
}

async function main(): Promise<void> {
  const prisma = getPrismaClient()
  try {
    const config = loadBlockerConfig()
    await runBlockCycle({
      config,
      prisma,
      startOrResumeBlockRun,
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
