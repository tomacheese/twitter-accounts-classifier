import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { Logger } from '@book000/node-utils'
import { PrismaClient } from '../generated/prisma'
import { parsePositiveIntEnv } from '../config/env'

const logger = Logger.configure('storage-guard-cycle')

const STORAGE_CAPACITY_STATE_ID = 'singleton'
// tsc は scripts/ を dist/scripts/ へそのまま出力するため、ビルド後は __dirname から
// リポジトリルートまでの相対段数が開発時 (ts-node 実行) と変わってしまう。
// crawler パッケージの cwd (dev・コンテナ共に crawler ディレクトリ) は変わらないため、
// process.cwd() を基点にする。
const GUARD_SCRIPT_PATH = path.join(process.cwd(), '..', 'scripts', 'check-postgres-storage.sh')

/**
 * `storage-guard-cycle` の実行間隔 (秒)。
 * @returns 実行間隔 (秒)。既定 300
 */
export function getStorageGuardIntervalSeconds(): number {
  return parsePositiveIntEnv('STORAGE_GUARD_INTERVAL_SECONDS', 300)
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
 * `check-postgres-storage.sh` を子プロセスとして実行し、標準出力を返す。
 * 終了コードが非ゼロ (閾値超過) でも出力自体は計測結果として有効なため、
 * 例外を投げず標準出力を捕捉する。
 * @returns 標準出力 (df 自体が失敗し stdout が空の場合は空文字列)
 */
function runStorageGuardScript(): string {
  try {
    return execFileSync(GUARD_SCRIPT_PATH, { encoding: 'utf8' })
  } catch (error) {
    // 非ゼロ終了時は execFileSync が例外を投げるが、閾値超過による想定内の
    // 非ゼロ終了と df 自体の失敗を区別する必要はなく、どちらも stdout の
    // 抽出可否だけで後続の upsert 有無を決める。
    const stdout = (error as { stdout?: Buffer | string }).stdout
    return stdout === undefined ? '' : stdout.toString()
  }
}

/**
 * ストレージ計測を 1 回実行し、抽出できた場合のみ `StorageCapacityState` を upsert する。
 * @param prisma - Prisma クライアント
 */
export async function runStorageGuardCycleOnce(prisma: PrismaClient): Promise<void> {
  const stdout = runStorageGuardScript()
  const measurement = parseStorageGuardOutput(stdout)
  if (!measurement) {
    logger.error(`could not parse check-postgres-storage.sh output: ${stdout}`)
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
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

// eslint-disable-next-line unicorn/prefer-module
if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error(`storage guard process crashed: ${String(error)}`)
    process.exitCode = 1
  })
}
