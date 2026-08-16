import { describe, expect, it, vi } from 'vitest'
import { createBlock } from './blocks-client'

const cookies = { ct0: 'csrf-token', authToken: 'auth-token-value' }

describe('createBlock actor unavailable', () => {
  it('throws BlockActorUnavailableError for HTTP 403 + X error code 64', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json(
        {
          errors: [
            {
              code: 64,
              message: 'Your account is suspended and is not permitted to access this feature.',
            },
          ],
        },
        { status: 403 },
      ),
    )

    await expect(
      createBlock(cookies, fetchImpl as unknown as typeof fetch, '999'),
    ).rejects.toMatchObject({ name: 'BlockActorUnavailableError', httpStatus: 403, xErrorCode: 64 })
  })

  it('does not include the target user id in the error message', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(Response.json({ errors: [{ code: 64 }] }, { status: 403 }))

    await expect(
      createBlock(cookies, fetchImpl as unknown as typeof fetch, 'target-user-999'),
    ).rejects.toMatchObject({
      message: expect.not.stringContaining('target-user-999'),
    })
  })

  it('keeps other 403 responses as ResponseError', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { errors: [{ code: 9999, message: 'fixture generic error' }] },
          { status: 403 },
        ),
      )

    await expect(
      createBlock(cookies, fetchImpl as unknown as typeof fetch, '999'),
    ).rejects.toMatchObject({ name: 'ResponseError', response: { status: 403 } })
  })
})
