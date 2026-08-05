import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { classifyPrStatus, type PrSnapshot } from '../lib/pr-lifecycle'

const PR_VIEW_FIELDS =
  'state,mergeable,mergeStateStatus,autoMergeRequest,reviewDecision,statusCheckRollup'

function runGh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' })
}

const PR_STATES: readonly PrSnapshot['state'][] = ['OPEN', 'CLOSED', 'MERGED']
const MERGEABLE_VALUES: readonly PrSnapshot['mergeable'][] = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN']

/**
 * @param value - `gh pr view --json` の出力を `JSON.parse` した値
 * @returns value が `PrSnapshot` の形を満たすか
 */
export function isPrSnapshot(value: unknown): value is PrSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.state !== 'string' ||
    !(PR_STATES as readonly string[]).includes(candidate.state)
  ) {
    return false
  }
  if (
    typeof candidate.mergeable !== 'string' ||
    !(MERGEABLE_VALUES as readonly string[]).includes(candidate.mergeable)
  ) {
    return false
  }
  return Array.isArray(candidate.statusCheckRollup)
}

function fetchSnapshot(prNumber: string): PrSnapshot {
  const raw = runGh(['pr', 'view', prNumber, '--json', PR_VIEW_FIELDS])
  const parsed: unknown = JSON.parse(raw)
  if (!isPrSnapshot(parsed)) {
    throw new Error(`Unexpected \`gh pr view\` JSON shape for PR #${prNumber}`)
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
