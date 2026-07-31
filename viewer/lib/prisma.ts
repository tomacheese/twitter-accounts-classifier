import { PrismaClient } from '../generated/prisma'

let client: PrismaClient | undefined

/**
 * Returns the shared Prisma Client instance for the viewer app, creating it on first use.
 * @returns the process-wide Prisma Client instance
 */
export function getPrismaClient(): PrismaClient {
  client ??= new PrismaClient()
  return client
}
