import { PrismaClient } from '../generated/prisma'

let client: PrismaClient | undefined

/**
 * analyzer 全体で単一の PrismaClient を共有する。
 * worker ループの各イテレーションで new すると connection pool を使い切るため、
 * プロセス生存期間で 1 つに固定している。
 */
export function getPrismaClient(): PrismaClient {
  client ??= new PrismaClient()
  return client
}

/**
 * 共有している PrismaClient の接続を切断する。
 */
export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect()
    client = undefined
  }
}
