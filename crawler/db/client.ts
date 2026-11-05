import { createIdBoundaryExtension } from 'id-boundary'
import { Prisma, PrismaClient } from '../generated/prisma'

let client: PrismaClient | undefined

export function getPrismaClient(): PrismaClient {
  // query extension は型を変えないため、型は生成済みの PrismaClient のままにする。
  // ID の型 (bigint ではなく string) は stringify-bigint-types.mjs が生成物へ反映している。
  client ??= new PrismaClient().$extends(
    createIdBoundaryExtension(Prisma),
  ) as unknown as PrismaClient
  return client
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect()
    client = undefined
  }
}
