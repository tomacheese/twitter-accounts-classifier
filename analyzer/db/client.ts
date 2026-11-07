import { createIdBoundaryExtension } from 'id-boundary'
import { Prisma, PrismaClient } from '../generated/prisma'

let client: PrismaClient | undefined
let leaseClient: PrismaClient | undefined

/**
 * analyzer 全体で単一の PrismaClient を共有する。
 * worker ループの各イテレーションで new すると connection pool を使い切るため、
 * プロセス生存期間で 1 つに固定している。
 */
export function getPrismaClient(): PrismaClient {
  // query extension は型を変えないため、型は生成済みの PrismaClient のままにする。
  client ??= new PrismaClient().$extends(
    createIdBoundaryExtension(Prisma),
  ) as unknown as PrismaClient
  return client
}

/**
 * 長時間の集計 query が処理用 pool の唯一の connection を占有していても
 * WorkItem lease を更新できるよう、lease 更新専用の独立 PrismaClient を返す。
 */
export function getLeasePrismaClient(): PrismaClient {
  leaseClient ??= new PrismaClient().$extends(
    createIdBoundaryExtension(Prisma),
  ) as unknown as PrismaClient
  return leaseClient
}

/**
 * 切断後に client を破棄するのは、再度 getPrismaClient が呼ばれた際に
 * 切断済みインスタンスを再利用させないため。
 */
export async function disconnectPrisma(): Promise<void> {
  await Promise.all([client?.$disconnect(), leaseClient?.$disconnect()])
  client = undefined
  leaseClient = undefined
}
