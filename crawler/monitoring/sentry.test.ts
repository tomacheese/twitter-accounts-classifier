import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const initMock = vi.fn()
const captureExceptionMock = vi.fn()

vi.mock('@sentry/node', () => ({
  init: initMock,
  captureException: captureExceptionMock,
}))

describe('monitoring/sentry', () => {
  const originalDsn = process.env.GLITCHTIP_DSN

  beforeEach(() => {
    vi.resetModules()
    initMock.mockClear()
    captureExceptionMock.mockClear()
  })

  afterEach(() => {
    if (originalDsn === undefined) {
      delete process.env.GLITCHTIP_DSN
    } else {
      process.env.GLITCHTIP_DSN = originalDsn
    }
  })

  it('does not initialize Sentry when GLITCHTIP_DSN is unset', async () => {
    delete process.env.GLITCHTIP_DSN
    const { initMonitoring, captureException } = await import('./sentry')
    initMonitoring()
    captureException(new Error('boom'))
    expect(initMock).not.toHaveBeenCalled()
    expect(captureExceptionMock).not.toHaveBeenCalled()
  })

  it('initializes Sentry and forwards captured exceptions when GLITCHTIP_DSN is set', async () => {
    process.env.GLITCHTIP_DSN = 'https://example.test/1'
    const { initMonitoring, captureException } = await import('./sentry')
    initMonitoring()
    expect(initMock).toHaveBeenCalledWith(expect.objectContaining({ dsn: 'https://example.test/1' }))

    const error = new Error('boom')
    captureException(error)
    expect(captureExceptionMock).toHaveBeenCalledWith(error, undefined)
  })
})
