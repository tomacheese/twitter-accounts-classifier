import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { loadReplyCorpus } from './reply-corpus'

describe('loadReplyCorpus', () => {
  it('filters by isReply and the given watermark, ordering by collectedAt desc then id desc', async () => {
    const findMany = vi.fn().mockResolvedValue([])
    const prisma = { tweet: { findMany } } as unknown as PrismaClient
    const watermark = new Date('2026-01-01T00:00:00Z')

    await loadReplyCorpus(prisma, watermark)

    const call = findMany.mock.calls[0][0] as Record<string, unknown>
    expect(call.where).toEqual({ isReply: true, collectedAt: { lte: watermark } })
    expect(call.orderBy).toEqual([{ collectedAt: 'desc' }, { id: 'desc' }])
  })
})

describe('reply corpus partial index migration', () => {
  it('defines Tweet_reply_corpus_idx with the expected column order and predicate', () => {
    // tsconfig の module は CommonJS のため import.meta は使えない。
    // eslint-disable-next-line unicorn/prefer-module
    const migrationsDir = path.join(__dirname, '../../prisma/migrations')
    const dirs = readdirSync(migrationsDir).filter((d) =>
      d.includes('add_reply_corpus_partial_index'),
    )
    expect(dirs.length).toBe(1)
    const sql = readFileSync(path.join(migrationsDir, dirs[0], 'migration.sql'), 'utf8')
    expect(sql).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS "Tweet_reply_corpus_idx"/)
    expect(sql).toMatch(/ON "Tweet"/)
    expect(sql).toMatch(/"collectedAt" DESC, "id" DESC/)
    expect(sql).toMatch(/WHERE "isReply" = true/)
  })
})
