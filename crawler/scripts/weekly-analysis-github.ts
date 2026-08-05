import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { classifyPrStatus, type PrSnapshot } from '../lib/pr-lifecycle'

const PR_VIEW_FIELDS =
  'state,mergeable,mergeStateStatus,autoMergeRequest,reviewDecision,statusCheckRollup'

function runGh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' })
}

function fetchSnapshot(prNumber: string): PrSnapshot {
  const raw = runGh(['pr', 'view', prNumber, '--json', PR_VIEW_FIELDS])
  const parsed = JSON.parse(raw) as {
    state: PrSnapshot['state']
    mergeable: PrSnapshot['mergeable']
    mergeStateStatus: string
    autoMergeRequest: { enabledAt: string } | null
    reviewDecision: string | null
    statusCheckRollup: { name: string; conclusion: string | null; status: string }[]
  }
  return parsed
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value))
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2)
  const { values } = parseArgs({
    args: rest,
    options: {
      pr: { type: 'string' },
      message: { type: 'string' },
      reviewer: { type: 'string' },
    },
  })

  if (!values.pr) throw new Error('--pr is required')

  switch (command) {
    case 'status': {
      const snapshot = fetchSnapshot(values.pr)
      printJson({ status: classifyPrStatus(snapshot), snapshot })
      return
    }
    case 'request-review': {
      if (!values.reviewer) throw new Error('--reviewer is required')
      runGh(['pr', 'edit', values.pr, '--add-reviewer', values.reviewer])
      printJson({ ok: true })
      return
    }
    case 'enable-auto-merge': {
      runGh(['pr', 'merge', values.pr, '--auto', '--squash'])
      printJson({ ok: true })
      return
    }
    case 'disable-auto-merge': {
      runGh(['pr', 'merge', values.pr, '--disable-auto'])
      printJson({ ok: true })
      return
    }
    case 'comment': {
      if (!values.message) throw new Error('--message is required')
      runGh(['pr', 'comment', values.pr, '--body', values.message])
      printJson({ ok: true })
      return
    }
    case 'close': {
      const args = ['pr', 'close', values.pr]
      if (values.message) args.push('--comment', values.message)
      runGh(args)
      printJson({ ok: true })
      return
    }
    default: {
      throw new Error(`Unknown command: ${command}`)
    }
  }
}

try {
  main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
