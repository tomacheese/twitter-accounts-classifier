import { createIdBoundaryExtension } from 'id-boundary'
import { Prisma, PrismaClient } from '../generated/prisma'

let client: PrismaClient | undefined

/**
 * プロセス内で単一の PrismaClient インスタンスを共有する。
 * @returns 共有された PrismaClient
 */
export function getPrismaClient(): PrismaClient {
  // query extension は型を変えないため、型は生成済みの PrismaClient のままにする。
  client ??= new PrismaClient().$extends(
    createIdBoundaryExtension(Prisma),
  ) as unknown as PrismaClient
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
