import { PrismaClient } from '../generated/prisma'

let client: PrismaClient | undefined

/**
 * プロセス内で単一の PrismaClient インスタンスを共有する。
 * @returns 共有された PrismaClient
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
