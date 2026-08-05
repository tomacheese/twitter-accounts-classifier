import { parseArgs } from 'node:util'
import { PrismaClient } from '../generated/prisma'
import {
  completeWeeklyAnalysisRun,
  createWeeklyAnalysisRun,
  failWeeklyAnalysisRun,
  getWeeklyAnalysisRun,
  listRunningWeeklyAnalysisRuns,
  timeoutWeeklyAnalysisRun,
  touchWeeklyAnalysisRunHeartbeat,
} from '../db/weekly-analysis-run-repository'
import { getWeeklyAnalysisStaleThresholdSeconds } from '../config/env'

function printJson(value: unknown): void {
  console.log(JSON.stringify(value))
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
        printJson(
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
          },
        })
        if (!values.id) throw new Error('--id is required')
        printJson(
          await completeWeeklyAnalysisRun(prisma, values.id, new Date(), {
            sampledAccountIds: values['sampled-account-ids']
              ? (JSON.parse(values['sampled-account-ids']) as unknown)
              : [],
            findings: values.findings ?? null,
            commitSha: values['commit-sha'] ?? null,
            pullRequestNumber: values['pull-request-number']
              ? Number(values['pull-request-number'])
              : null,
            pullRequestUrl: values['pull-request-url'] ?? null,
          }),
        )
        return
      }
      case 'fail': {
        const { values } = parseArgs({
          args: rest,
          options: { id: { type: 'string' }, message: { type: 'string' } },
        })
        if (!values.id || !values.message) throw new Error('--id and --message are required')
        printJson(await failWeeklyAnalysisRun(prisma, values.id, new Date(), values.message))
        return
      }
      case 'timeout': {
        const { values } = parseArgs({
          args: rest,
          options: { id: { type: 'string' }, message: { type: 'string' } },
        })
        if (!values.id || !values.message) throw new Error('--id and --message are required')
        printJson(await timeoutWeeklyAnalysisRun(prisma, values.id, new Date(), values.message))
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
