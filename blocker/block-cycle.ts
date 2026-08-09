import { Logger } from '@book000/node-utils'
import { withTwitterRetry, type IssuedCookies, type OpenApiClientContext } from 'twitter-client'
import type { PrismaClient } from './generated/prisma'
import type { BlockerAccountConfig } from './config/load-config'
import type { BlockLimits } from './config/block-limits'
import { selectBlockCandidates, type BlockCandidate } from './db/candidate-repository'
import { recordSuccessfulBlock } from './db/block-repository'
import {
  startBlockAccountRun,
  finishBlockAccountRun,
  recordBlockAction,
} from './db/block-run-repository'
import {
  findOrCreateOutboxEntry,
  markOutboxRemoteSucceeded,
  markOutboxLocalPersisted,
  markOutboxRemoteFailed,
} from './db/outbox-repository'
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
  findOrCreateOutboxEntry: typeof findOrCreateOutboxEntry
  markOutboxRemoteSucceeded: typeof markOutboxRemoteSucceeded
  markOutboxLocalPersisted: typeof markOutboxLocalPersisted
  markOutboxRemoteFailed: typeof markOutboxRemoteFailed
  prisma: PrismaClient
  limits: BlockLimits
  sleepImpl?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `crawl.ts` の `syncFollowingPhase` と同じ方法 (`getUserByScreenName`) を使う。
 * @param client - ログイン済みの OpenAPI クライアント
 * @param username - 解決対象のログインアカウントのユーザー名
 * @returns 解決した `Account.id`
 */
export async function resolveOwnAccountId(
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
 * outbox entry を `createBlock` (remote) の前に確定させることで、Twitter 側の block が
 * 成立した直後に DB 障害が起きても「成立したかどうか不明」な状態を残さず、
 * reconciliation が Twitter 側の実態から補修できるようにする。
 * 1 件の失敗が残りの候補の処理を止めないよう、この関数自身は例外を投げない。
 * Twitter 側への `createBlock` とその後の `BlockAction` 記録を別々の try で囲む: 記録側の
 * DB エラーを `createBlock` の失敗と同じ `catch` にまとめると、実際にはブロックが成立した
 * 候補まで `result: 'failure'` として記録されてしまい、履行済みの操作が誤って再試行対象になる。
 * @param client - ログイン済みの OpenAPI クライアント
 * @param deps - ブロック実行に必要な依存関数一式
 * @param blockAccountRunId - 記録先の `BlockAccountRun` ID
 * @param blockerId - ブロックを実行するアカウント
 * @param candidate - ブロック対象と根拠ラベル・確信度
 * @returns ブロックに成功したかどうか
 */
export async function attemptBlock(
  client: OpenApiClientContext,
  deps: BlockAccountCycleDependencies,
  blockAccountRunId: string,
  blockerId: string,
  candidate: BlockCandidate,
): Promise<boolean> {
  const outboxEntry = await deps.findOrCreateOutboxEntry(deps.prisma, {
    blockAccountRunId,
    blockerId,
    blockedId: candidate.accountId,
    labelDefinitionId: candidate.labelDefinitionId,
    confidence: candidate.confidence,
  })

  try {
    await withTwitterRetry(() => client.createBlock(candidate.accountId))
  } catch (error) {
    logger.error(
      `Failed to block account ${candidate.accountId} on behalf of ${blockerId}`,
      error as Error,
    )
    captureException(error, { blockerId, blockedId: candidate.accountId })
    await deps.markOutboxRemoteFailed(deps.prisma, outboxEntry.id)
    await deps.recordBlockAction(deps.prisma, {
      blockAccountRunId,
      blockerId,
      blockedId: candidate.accountId,
      labelDefinitionId: candidate.labelDefinitionId,
      confidence: candidate.confidence,
      result: 'failure',
      errorMessage: error instanceof Error ? error.message : String(error),
      outboxEntryId: outboxEntry.id,
    })
    return false
  }

  await deps.markOutboxRemoteSucceeded(deps.prisma, outboxEntry.id)

  try {
    await deps.recordSuccessfulBlock(deps.prisma, blockerId, candidate.accountId, blockAccountRunId)
    await deps.recordBlockAction(deps.prisma, {
      blockAccountRunId,
      blockerId,
      blockedId: candidate.accountId,
      labelDefinitionId: candidate.labelDefinitionId,
      confidence: candidate.confidence,
      result: 'success',
      errorMessage: null,
      outboxEntryId: outboxEntry.id,
    })
    await deps.markOutboxLocalPersisted(deps.prisma, outboxEntry.id)
  } catch (error) {
    logger.error(
      `Blocked account ${candidate.accountId} but failed to record it for ${blockerId}`,
      error as Error,
    )
    captureException(error, { blockerId, blockedId: candidate.accountId })
  }
  return true
}

/**
 * own account 解決に失敗した場合は候補選定以降を行わない
 * (`crawl.ts` の `syncFollowingPhase` が own account 解決失敗時に以降の phase をすべてスキップするのと同じ考え方)。
 * 認証 (`issueCookies`/`createOpenApiClient`) の失敗も同様に `failed: true` の summary を返す:
 * ここで投げたまま呼び出し元に伝播させると、その `BlockAccountRun` 行自体が作成されず
 * Discord 通知からもエラートラッキングからも見えなくなる。
 * @param deps - ブロック実行に必要な依存関数一式
 * @param account - 処理対象のアカウント設定 (`blockEnabled: true` のもののみ)
 * @param blockRunId - 今回の `BlockRun` ID
 * @returns Discord 通知に使うアカウント単位の集計
 */
export async function runBlockAccountCycle(
  deps: BlockAccountCycleDependencies,
  account: Extract<BlockerAccountConfig, { blockEnabled: true }>,
  blockRunId: string,
): Promise<AccountRunSummary> {
  const startedAt = new Date()
  const failedSummary: AccountRunSummary = {
    username: account.username,
    blockedCount: 0,
    failedCount: 0,
    failed: true,
  }

  async function recordFailedAccountRun(error: unknown): Promise<void> {
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
  }

  let context: OpenApiClientContext
  try {
    const cookies = await deps.issueCookies({
      username: account.username,
      password: account.password,
      otp_secret: account.otpSecret,
    })
    context = await deps.createOpenApiClient(cookies)
  } catch (error) {
    logger.error(`Failed to authenticate ${account.username}, skipping block cycle`, error as Error)
    captureException(error, { username: account.username })
    await recordFailedAccountRun(error)
    return failedSummary
  }

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
      await recordFailedAccountRun(error)
      return failedSummary
    }

    const accountRun = await deps.startBlockAccountRun(deps.prisma, {
      blockRunId,
      username: account.username,
      startedAt,
    })

    const candidates = await deps.selectBlockCandidates(
      deps.prisma,
      blockerId,
      account.blockRule,
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

    return { username: account.username, blockedCount, failedCount, failed: false }
  } finally {
    await deps.closeOpenApiClient(context)
  }
}
