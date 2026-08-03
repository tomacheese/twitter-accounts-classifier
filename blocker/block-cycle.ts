import { Logger } from '@book000/node-utils'
import { withTwitterRetry, type IssuedCookies, type OpenApiClientContext } from 'twitter-client'
import type { PrismaClient } from './generated/prisma'
import type { BlockerAccountConfig, BlockerAppConfig } from './config/load-config'
import { resolveBlockRule } from './config/load-config'
import type { BlockLimits } from './config/block-limits'
import { selectBlockCandidates, type BlockCandidate } from './db/candidate-repository'
import { recordSuccessfulBlock } from './db/block-repository'
import {
  startBlockAccountRun,
  finishBlockAccountRun,
  recordBlockAction,
} from './db/block-run-repository'
import { captureException } from './monitoring/sentry'
import type { AccountRunSummary } from './discord-notifier'

const logger = Logger.configure('block-cycle')

export interface BlockAccountCycleDependencies {
  issueCookies: (account: {
    username: string
    password: string
    otp_secret: string | null
  }) => Promise<IssuedCookies>
  createOpenApiClient: (cookies: IssuedCookies) => Promise<OpenApiClientContext>
  closeOpenApiClient: (context: OpenApiClientContext) => Promise<void>
  selectBlockCandidates: typeof selectBlockCandidates
  recordSuccessfulBlock: typeof recordSuccessfulBlock
  startBlockAccountRun: typeof startBlockAccountRun
  finishBlockAccountRun: typeof finishBlockAccountRun
  recordBlockAction: typeof recordBlockAction
  prisma: PrismaClient
  limits: BlockLimits
  sleepImpl?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `crawl.ts` の `syncFollowingPhase` と同じ方法 (`getUserByScreenName`) で
 * このアカウント自身の `Account.id` を解決する。
 * @param client - ログイン済みの OpenAPI クライアント
 * @param username - 解決対象のログインアカウントのユーザー名
 * @returns 解決した `Account.id`
 */
async function resolveOwnAccountId(
  client: OpenApiClientContext,
  username: string,
): Promise<string> {
  const response = await withTwitterRetry(() =>
    client.client.getUserApi().getUserByScreenName({ screenName: username }),
  )
  const restId = response.data.user?.restId
  if (!restId) throw new Error(`getUserByScreenName returned no user for ${username}`)
  return restId
}

/**
 * 候補 1 件分のブロックを試行し、成功・失敗いずれの場合も `BlockAction` へ記録する。
 * 1 件の失敗が残りの候補の処理を止めないよう、この関数自身は例外を投げない。
 * @param client - ログイン済みの OpenAPI クライアント
 * @param deps - ブロック実行に必要な依存関数一式
 * @param blockAccountRunId - 記録先の `BlockAccountRun` ID
 * @param blockerId - ブロックを実行するアカウント
 * @param candidate - ブロック対象と根拠ラベル・確信度
 * @returns ブロックに成功したかどうか
 */
async function attemptBlock(
  client: OpenApiClientContext,
  deps: BlockAccountCycleDependencies,
  blockAccountRunId: string,
  blockerId: string,
  candidate: BlockCandidate,
): Promise<boolean> {
  try {
    await withTwitterRetry(() => client.createBlock(candidate.accountId))
    await deps.recordSuccessfulBlock(deps.prisma, blockerId, candidate.accountId)
    await deps.recordBlockAction(deps.prisma, {
      blockAccountRunId,
      blockerId,
      blockedId: candidate.accountId,
      labelDefinitionId: candidate.labelDefinitionId,
      confidence: candidate.confidence,
      result: 'success',
      errorMessage: null,
    })
    return true
  } catch (error) {
    logger.error(
      `Failed to block account ${candidate.accountId} on behalf of ${blockerId}`,
      error as Error,
    )
    captureException(error, { blockerId, blockedId: candidate.accountId })
    await deps.recordBlockAction(deps.prisma, {
      blockAccountRunId,
      blockerId,
      blockedId: candidate.accountId,
      labelDefinitionId: candidate.labelDefinitionId,
      confidence: candidate.confidence,
      result: 'failure',
      errorMessage: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * `block_enabled` な 1 アカウント分の、own account 解決からブロック履行記録までの全処理を行う。
 * own account 解決に失敗した場合は候補選定以降を行わず、件数 0 の summary を返す
 * (`crawl.ts` の `syncFollowingPhase` が own account 解決失敗時に以降の phase をすべて
 * スキップするのと同じ考え方)。
 * @param deps - ブロック実行に必要な依存関数一式
 * @param account - 処理対象のアカウント設定
 * @param config - アプリ全体の設定 (グローバルルール解決に使う)
 * @param blockRunId - 今回の `BlockRun` ID
 * @returns Discord 通知に使うアカウント単位の集計
 */
export async function runBlockAccountCycle(
  deps: BlockAccountCycleDependencies,
  account: BlockerAccountConfig,
  config: BlockerAppConfig,
  blockRunId: string,
): Promise<AccountRunSummary> {
  const startedAt = new Date()
  const zeroSummary: AccountRunSummary = {
    username: account.username,
    blockedCount: 0,
    failedCount: 0,
  }

  const cookies = await deps.issueCookies({
    username: account.username,
    password: account.password,
    otp_secret: account.otpSecret,
  })
  const context = await deps.createOpenApiClient(cookies)

  try {
    let blockerId: string
    try {
      blockerId = await resolveOwnAccountId(context, account.username)
    } catch (error) {
      logger.error(
        `Failed to resolve own account for ${account.username}, skipping block cycle`,
        error as Error,
      )
      captureException(error, { username: account.username })
      const accountRun = await deps.startBlockAccountRun(deps.prisma, {
        blockRunId,
        username: account.username,
        startedAt,
      })
      await deps.finishBlockAccountRun(deps.prisma, accountRun.id, {
        finishedAt: new Date(),
        status: 'failed',
        candidatesCount: 0,
        blockedCount: 0,
        failedCount: 0,
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      return zeroSummary
    }

    const rule = resolveBlockRule(account, config)
    const accountRun = await deps.startBlockAccountRun(deps.prisma, {
      blockRunId,
      username: account.username,
      startedAt,
    })

    const candidates = await deps.selectBlockCandidates(
      deps.prisma,
      blockerId,
      rule,
      deps.limits.maxPerAccountPerRun,
    )

    let blockedCount = 0
    let failedCount = 0
    const sleepImpl = deps.sleepImpl ?? defaultSleep

    for (const [index, candidate] of candidates.entries()) {
      if (index > 0) await sleepImpl(deps.limits.actionDelayMs)
      const succeeded = await attemptBlock(context, deps, accountRun.id, blockerId, candidate)
      if (succeeded) blockedCount++
      else failedCount++
    }

    await deps.finishBlockAccountRun(deps.prisma, accountRun.id, {
      finishedAt: new Date(),
      status: 'completed',
      candidatesCount: candidates.length,
      blockedCount,
      failedCount,
      errorMessage: null,
    })

    return { username: account.username, blockedCount, failedCount }
  } finally {
    await deps.closeOpenApiClient(context)
  }
}
