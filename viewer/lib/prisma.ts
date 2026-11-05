import { createIdBoundaryExtension } from 'id-boundary'
import { Prisma, PrismaClient } from '../generated/prisma'

let client: PrismaClient | undefined

/**
 * viewer アプリ全体で共有する Prisma Client を返す。初回呼び出し時に生成する。
 * @returns プロセス全体で共有する Prisma Client インスタンス
 */
export function getPrismaClient(): PrismaClient {
  // query extension は型を変えないため、型は生成済みの PrismaClient のままにする。
  client ??= new PrismaClient().$extends(
    createIdBoundaryExtension(Prisma),
  ) as unknown as PrismaClient
  return client
}
