import { Logger } from '@book000/node-utils'
import {
  createCookieIssuerClient,
  createOpenApiClient,
  closeOpenApiClient,
  type IssuedCookies,
} from 'twitter-client'
import type { PrismaClient } from './generated/prisma'
import { getPrismaClient, disconnectPrisma } from './db/client'
import { upsertComponentBuildIdentity } from './build-identity'
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
import {
  findOrCreateOutboxEntry,
  markOutboxRemoteSucceeded,
  markOutboxLocalPersisted,
  markOutboxRemoteFailed,
  markOutboxRemoteSkipped,
  findStalledOutboxEntries,
  findExistingBlockedIds,
  findOutboxEntryIdsWithBlockAction,
} from './db/outbox-repository'
import { runBlockAccountCycle, resolveOwnAccountId } from './block-cycle'
import { reconcileOutboxEntries, fetchRemotelyBlockedIds } from './reconciliation'
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
  /** アカウント単位で停滞 outbox entry を補修する。 */
  reconcileAccountOutbox: (
    account: Extract<BlockerAccountConfig, { blockEnabled: true }>,
    prisma: PrismaClient,
    cookies?: IssuedCookies,
  ) => Promise<void>
}

/**
 * 認証をこの関数内で行うのは、reconciliation が block cycle 本体とは別に常に全アカウントに対して実行される (block 対象候補が無いアカウントでも停滞 entry の有無を確認する必要がある) ためである。
 * @param account - reconciliation 対象のアカウント設定
 * @param prisma - Prisma クライアント
 * @param cookies - block 本処理で取得済みの認証情報。渡された場合は再利用し、Cookie Issuer への発行 request を追加で行わない
 */
async function reconcileAccountOutbox(
  account: Extract<BlockerAccountConfig, { blockEnabled: true }>,
  prisma: PrismaClient,
  cookies?: IssuedCookies,
): Promise<void> {
  const issuedCookies =
    cookies ??
    (await createCookieIssuerClient({
      baseUrl: getCookieIssuerBaseUrl(),
      clientName: 'blocker',
    }).issueCookiesWithRetry({
      username: account.username,
      password: account.password,
      otp_secret: account.otpSecret,
    }))
  const client = await createOpenApiClient(issuedCookies)
  try {
    const blockerId = await resolveOwnAccountId(client, account.username)
    await reconcileOutboxEntries(
      {
        prisma,
        blockerId,
        client,
        findStalledOutboxEntries,
        findExistingBlockedIds,
        findOutboxEntryIdsWithBlockAction,
        recordSuccessfulBlock,
        recordBlockAction,
        markOutboxRemoteSucceeded,
        markOutboxLocalPersisted,
        markOutboxRemoteFailed,
        fetchRemotelyBlockedIds,
      },
      prisma,
    )
  } finally {
    await closeOpenApiClient(client)
  }
}

/**
 * 1 アカウントの処理が例外を投げても、他アカウントの処理は継続する
 * (`crawl.ts` の各アカウントループと同じ考え方)。
 * いずれかのアカウントが失敗した場合は `BlockRun` 自体の status も `'failed'` にする:
 * 個々の `BlockAccountRun` にしか失敗が残らないと、放置しても誰も気付けない。
 * block 本処理と reconciliation を同じ loop 内で連続して行うことで、通常は Cookie Issuer 認証を 1 回に抑える。
 * reconciliation の失敗は log と captureException のみ行い、`BlockRun` の status には反映しない。
 * @param deps - このサイクルに必要な依存関数一式
 */
export async function runBlockCycle(deps: RunBlockCycleDependencies): Promise<void> {
  const startedAt = new Date()
  const staleThresholdMs = getBlockIntervalSeconds() * getBlockStaleThresholdMultiplier() * 1000
  const run = await deps.startOrResumeBlockRun(deps.prisma, startedAt, staleThresholdMs)
  const summaries: AccountRunSummary[] = []
  const completedUsernames = new Set(run.completedUsernames)
  const targetAccounts = deps.config.accounts.filter(
    (account): account is Extract<BlockerAccountConfig, { blockEnabled: true }> =>
      account.blockEnabled && !completedUsernames.has(account.username),
  )

  for (const account of targetAccounts) {
    await deps.touchBlockRunHeartbeat(deps.prisma, run.id, new Date(), staleThresholdMs)
    let capturedCookies: IssuedCookies | undefined
    try {
      const summary = await deps.runBlockAccountCycle(
        {
          issueCookies: async (issuedAccount) => {
            const cookies = await createCookieIssuerClient({
              baseUrl: getCookieIssuerBaseUrl(),
              clientName: 'blocker',
            }).issueCookiesWithRetry(issuedAccount)
            capturedCookies = cookies
            return cookies
          },
          createOpenApiClient,
          closeOpenApiClient,
          selectBlockCandidates,
          recordSuccessfulBlock,
          startBlockAccountRun,
          finishBlockAccountRun,
          recordBlockAction,
          findOrCreateOutboxEntry,
          markOutboxRemoteSucceeded,
          markOutboxLocalPersisted,
          markOutboxRemoteFailed,
          markOutboxRemoteSkipped,
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

    try {
      await deps.reconcileAccountOutbox(account, deps.prisma, capturedCookies)
    } catch (error) {
      logger.error(`Failed to reconcile outbox entries for ${account.username}`, error as Error)
      captureException(error, { username: account.username })
    }
  }

  await deps.notifyDiscord(deps.config.discordWebhookUrl, summaries)
  const runStatus = summaries.some((summary) => summary.failed)
    ? 'failed'
    : summaries.some((summary) => summary.failedCount > 0)
      ? 'partial'
      : 'completed'
  await deps.finishBlockRun(deps.prisma, run.id, new Date(), runStatus)
}

async function main(): Promise<void> {
  const prisma = getPrismaClient()
  try {
    await upsertComponentBuildIdentity(prisma, 'blocker')
    const config = loadBlockerConfig()
    await runBlockCycle({
      config,
      prisma,
      startOrResumeBlockRun,
      finishBlockRun,
      touchBlockRunHeartbeat,
      runBlockAccountCycle,
      notifyDiscord,
      reconcileAccountOutbox,
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
