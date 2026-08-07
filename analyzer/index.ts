import { Logger } from '@book000/node-utils'
import { getPrismaClient, disconnectPrisma } from './db/client'

const logger = Logger.configure('analyzer')

/**
 * worker ループの本体は Task 10 (WorkItem claim) 以降で実装する。
 * ここでは起動・終了の骨格のみを用意する。
 */
export async function main(): Promise<void> {
  const prisma = getPrismaClient()
  logger.info('analyzer starting')
  await prisma.$connect()
}

// このモジュールを import しただけでは実際の起動処理が走らないようにするガード。
// 直接実行 (`node dist/index.js`) した場合のみ動作する。require/module は、
// CommonJS を採用する本プロジェクトでこれを判定するのに適した手段である。
// eslint-disable-next-line unicorn/prefer-module
if (require.main === module) {
  main()
    .catch((error: unknown) => {
      logger.error('analyzer failed', error as Error)
      process.exitCode = 1
    })
    .finally(() => disconnectPrisma())
}
