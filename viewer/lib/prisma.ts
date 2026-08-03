import { PrismaClient } from '../generated/prisma'

let client: PrismaClient | undefined

/**
 * viewer アプリ全体で共有する Prisma Client を返す。初回呼び出し時に生成する。
 * @returns プロセス全体で共有する Prisma Client インスタンス
 */
export function getPrismaClient(): PrismaClient {
  client ??= new PrismaClient()
  return client
}
