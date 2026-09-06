import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { Logger } from '@book000/node-utils'
import { PrismaClient } from '../generated/prisma'
import { parsePositiveIntEnv } from '../config/env'
import { initMonitoring, captureException } from '../monitoring/sentry'

const logger = Logger.configure('storage-guard-cycle')

const STORAGE_CAPACITY_STATE_ID = 'singleton'
// tsc は scripts/ を dist/scripts/ へそのまま出力するため、ビルド後は __dirname から
// リポジトリルートまでの相対段数が開発時 (ts-node 実行) と変わってしまう。
// crawler パッケージの cwd (dev・コンテナ共に crawler ディレクトリ) は変わらないため、
// process.cwd() を基点にする。
const GUARD_SCRIPT_PATH = path.join(process.cwd(), '..', 'scripts', 'check-postgres-storage.sh')

/**
 * `storage-guard-cycle` の実行間隔 (秒)。
 * RELABEL_STORAGE_MAX_STALE_SECONDS (既定 180) より短くないと、正常稼働中でも
 * 前回計測からの経過時間が stale 判定に達し fail-closed が常時発火してしまう。
 * @returns 実行間隔 (秒)。既定 60
 */
export function getStorageGuardIntervalSeconds(): number {
  return parsePositiveIntEnv('STORAGE_GUARD_INTERVAL_SECONDS', 60)
}

export interface StorageGuardMeasurement {
  availableGib: number
  usedPercent: number
}

/**
 * `check-postgres-storage.sh` の標準出力から計測値を抽出する。
 * df 自体の失敗など、期待する行が出力されない場合は null を返す。
 * @param stdout - `check-postgres-storage.sh` の標準出力
 * @returns 抽出できた計測値、できなければ null
 */
export function parseStorageGuardOutput(stdout: string): StorageGuardMeasurement | null {
  const usedPercentMatch = /used_percent=(\d+)%/.exec(stdout)
  const availableGibMatch = /available_gib=([\d.]+)/.exec(stdout)
  if (!usedPercentMatch || !availableGibMatch) return null

  return {
    usedPercent: Number(usedPercentMatch[1]),
    availableGib: Number(availableGibMatch[1]),
  }
}

/**
 * `check-postgres-storage.sh` を子プロセスとして実行する。
 * 終了コード 0 (正常) と 1 (閾値超過) はどちらも計測行を標準出力へ出す契約のため、
 * 例外を投げる execFileSync ではなく、終了コードと標準出力を直接返す spawnSync を使う。
 * @returns spawnSync の実行結果
 */
function runStorageGuardScript(): ReturnType<typeof spawnSync> {
  return spawnSync(GUARD_SCRIPT_PATH, { encoding: 'utf8' })
}

/**
 * ストレージ計測を 1 回実行し、抽出できた場合のみ `StorageCapacityState` を upsert する。
 * プロセス自体を起動できない場合や、終了コード 2 (設定・df 自体の失敗) で計測行が
 * 出力されない場合は、直前の DB 状態を変えず GlitchTip へ通知するだけに留める。
 * @param prisma - Prisma クライアント
 */
export async function runStorageGuardCycleOnce(prisma: PrismaClient): Promise<void> {
  const result = runStorageGuardScript()
  if (result.error) {
    logger.error(`check-postgres-storage.sh execution failed: ${String(result.error)}`)
    captureException(result.error, { source: 'storage-guard-cycle.runStorageGuardCycleOnce' })
    return
  }

  const stdout = result.stdout.toString()
  const measurement = parseStorageGuardOutput(stdout)
  if (!measurement) {
    logger.error(
      `could not parse check-postgres-storage.sh output (exit ${String(result.status)}): ${stdout}${result.stderr.toString()}`,
    )
    captureException(new Error('could not parse check-postgres-storage.sh output'), {
      source: 'storage-guard-cycle.runStorageGuardCycleOnce',
    })
    return
  }

  await prisma.storageCapacityState.upsert({
    where: { id: STORAGE_CAPACITY_STATE_ID },
    create: {
      id: STORAGE_CAPACITY_STATE_ID,
      availableGib: measurement.availableGib,
      usedPercent: measurement.usedPercent,
      measuredAt: new Date(),
    },
    update: {
      availableGib: measurement.availableGib,
      usedPercent: measurement.usedPercent,
      measuredAt: new Date(),
    },
  })
}

async function main(): Promise<void> {
  const prisma = new PrismaClient()
  const intervalMs = getStorageGuardIntervalSeconds() * 1000
  for (;;) {
    try {
      await runStorageGuardCycleOnce(prisma)
    } catch (error) {
      logger.error(`storage guard cycle failed: ${String(error)}`)
      captureException(error, { source: 'storage-guard-cycle.main' })
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

// eslint-disable-next-line unicorn/prefer-module
if (require.main === module) {
  initMonitoring()
  main().catch((error: unknown) => {
    logger.error(`storage guard process crashed: ${String(error)}`)
    captureException(error, { source: 'storage-guard-cycle.main' })
    process.exitCode = 1
  })
}
