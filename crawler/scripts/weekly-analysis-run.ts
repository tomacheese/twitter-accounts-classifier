import { Logger } from '@book000/node-utils'
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { PrismaClient } from '../generated/prisma'
import {
  completeWeeklyAnalysisRun,
  createWeeklyAnalysisRun,
  failWeeklyAnalysisRun,
  getWeeklyAnalysisRun,
  listRunningWeeklyAnalysisRuns,
  recordWeeklyAnalysisRunPullRequest,
  timeoutWeeklyAnalysisRun,
  touchWeeklyAnalysisRunHeartbeat,
  type WeeklyAnalysisRunMutationResult,
} from '../db/weekly-analysis-run-repository'
import { getWeeklyAnalysisStaleThresholdSeconds } from '../config/env'
import { retryWeeklyAnalysisComplete } from './weekly-analysis-complete-retry'

const logger = Logger.configure('weekly-analysis-run')

function printJson(value: unknown): void {
  console.log(JSON.stringify(value))
}

/**
 * @param result - 状態遷移系サブコマンドの実行結果
 */
function reportMutationResult(result: WeeklyAnalysisRunMutationResult): void {
  printJson(result)
  if (!result.ok) {
    logger.warn(`WeeklyAnalysisRun mutation did not apply: ${JSON.stringify(result)}`)
    process.exitCode = 1
  }
}

/**
 * 構造化レビュー結果はコマンドライン引数に収まらない大きさになるため、
 * JSON 文字列ではなくファイル経由で受け取る。
 * @param filePath - structuredOutput を格納した JSON ファイルのパス
 * @returns パース済みの structuredOutput
 */
async function readStructuredOutputFile(filePath: string): Promise<unknown> {
  const content = await readFile(filePath, 'utf8')
  return JSON.parse(content) as unknown
}

async function main(): Promise<void> {
  const prisma = new PrismaClient()
  const [command, ...rest] = process.argv.slice(2)
  const staleThresholdMs = getWeeklyAnalysisStaleThresholdSeconds() * 1000

  try {
    switch (command) {
      case 'create': {
        const run = await createWeeklyAnalysisRun(prisma, new Date(), staleThresholdMs)
        printJson(run)
        return
      }
      case 'get': {
        const { values } = parseArgs({ args: rest, options: { id: { type: 'string' } } })
        if (!values.id) throw new Error('--id is required')
        printJson(await getWeeklyAnalysisRun(prisma, values.id))
        return
      }
      case 'list-running': {
        printJson(await listRunningWeeklyAnalysisRuns(prisma))
        return
      }
      case 'heartbeat': {
        const { values } = parseArgs({
          args: rest,
          options: { id: { type: 'string' }, phase: { type: 'string' } },
        })
        if (!values.id) throw new Error('--id is required')
        reportMutationResult(
          await touchWeeklyAnalysisRunHeartbeat(
            prisma,
            values.id,
            new Date(),
            staleThresholdMs,
            values.phase ?? null,
          ),
        )
        return
      }
      case 'record-pr': {
        const { values } = parseArgs({
          args: rest,
          options: {
            id: { type: 'string' },
            'pull-request-number': { type: 'string' },
            'pull-request-url': { type: 'string' },
          },
        })
        if (!values.id || !values['pull-request-number'] || !values['pull-request-url']) {
          throw new Error('--id, --pull-request-number and --pull-request-url are required')
        }
        reportMutationResult(
          await recordWeeklyAnalysisRunPullRequest(
            prisma,
            values.id,
            Number(values['pull-request-number']),
            values['pull-request-url'],
          ),
        )
        return
      }
      case 'complete': {
        const { values } = parseArgs({
          args: rest,
          options: {
            id: { type: 'string' },
            'sampled-account-ids': { type: 'string' },
            findings: { type: 'string' },
            'commit-sha': { type: 'string' },
            'pull-request-number': { type: 'string' },
            'pull-request-url': { type: 'string' },
            'structured-output-file': { type: 'string' },
          },
        })
        if (!values.id) throw new Error('--id is required')
        const id = values.id
        const structuredOutput =
          values['structured-output-file'] === undefined
            ? undefined
            : await readStructuredOutputFile(values['structured-output-file'])
        const completeParams = {
          ...(structuredOutput !== undefined && { structuredOutput }),
          ...(values['sampled-account-ids'] !== undefined && {
            sampledAccountIds: JSON.parse(values['sampled-account-ids']) as unknown,
          }),
          ...(values.findings !== undefined && { findings: values.findings }),
          ...(values['commit-sha'] !== undefined && { commitSha: values['commit-sha'] }),
          ...(values['pull-request-number'] !== undefined && {
            pullRequestNumber: Number(values['pull-request-number']),
          }),
          ...(values['pull-request-url'] !== undefined && {
            pullRequestUrl: values['pull-request-url'],
          }),
        }
        reportMutationResult(
          await retryWeeklyAnalysisComplete(
            () => completeWeeklyAnalysisRun(prisma, id, new Date(), completeParams),
            {
              onRetry(nextAttempt, maxAttempts) {
                logger.warn(
                  `WeeklyAnalysisRun complete hit a transient database/deployment error; retrying attempt ${nextAttempt}/${maxAttempts}`,
                )
              },
            },
          ),
        )
        return
      }
      case 'fail': {
        const { values } = parseArgs({
          args: rest,
          options: { id: { type: 'string' }, message: { type: 'string' } },
        })
        if (!values.id || !values.message) throw new Error('--id and --message are required')
        reportMutationResult(
          await failWeeklyAnalysisRun(prisma, values.id, new Date(), values.message),
        )
        return
      }
      case 'timeout': {
        const { values } = parseArgs({
          args: rest,
          options: { id: { type: 'string' }, message: { type: 'string' } },
        })
        if (!values.id || !values.message) throw new Error('--id and --message are required')
        reportMutationResult(
          await timeoutWeeklyAnalysisRun(prisma, values.id, new Date(), values.message),
        )
        return
      }
      default: {
        throw new Error(`Unknown command: ${command}`)
      }
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
