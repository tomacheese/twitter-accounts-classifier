import { describe, expect, it, vi } from 'vitest'
import { createBlock } from './blocks-client'

const cookies = { ct0: 'csrf-token', authToken: 'auth-token-value' }

describe('createBlock missing target', () => {
  it('throws BlockTargetNotFoundError for X API code 50', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json(
        { errors: [{ code: 50, message: 'fixture missing-user message' }] },
        { status: 404 },
      ),
    )

    await expect(
      createBlock(cookies, fetchImpl as unknown as typeof fetch, '999'),
    ).rejects.toMatchObject({ name: 'BlockTargetNotFoundError', targetUserId: '999' })
  })

  it('keeps other 404 responses as ResponseError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json(
        { errors: [{ code: 9999, message: 'fixture generic error' }] },
        { status: 404 },
      ),
    )

    await expect(
      createBlock(cookies, fetchImpl as unknown as typeof fetch, '999'),
    ).rejects.toMatchObject({ name: 'ResponseError', response: { status: 404 } })
  })
})
