import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const initMock = vi.fn()
const captureExceptionMock = vi.fn()
const captureMessageMock = vi.fn()

vi.mock('@sentry/node', () => ({
  init: initMock,
  captureException: captureExceptionMock,
  captureMessage: captureMessageMock,
}))

describe('monitoring/sentry', () => {
  const originalDsn = process.env.GLITCHTIP_DSN

  beforeEach(() => {
    vi.resetModules()
    initMock.mockClear()
    captureExceptionMock.mockClear()
    captureMessageMock.mockClear()
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
    const { initMonitoring, captureException, captureMessage } = await import('./sentry')
    initMonitoring()
    captureException(new Error('boom'))
    captureMessage('too many warnings')
    expect(initMock).not.toHaveBeenCalled()
    expect(captureExceptionMock).not.toHaveBeenCalled()
    expect(captureMessageMock).not.toHaveBeenCalled()
  })

  it('initializes Sentry and forwards captured exceptions when GLITCHTIP_DSN is set', async () => {
    process.env.GLITCHTIP_DSN = 'https://example.test/1'
    const { initMonitoring, captureException } = await import('./sentry')
    initMonitoring()
    expect(initMock).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: 'https://example.test/1' }),
    )

    const error = new Error('boom')
    captureException(error)
    expect(captureExceptionMock).toHaveBeenCalledWith(error, { extra: undefined })
  })

  it('forwards captured exceptions with extra context when GLITCHTIP_DSN is set', async () => {
    process.env.GLITCHTIP_DSN = 'https://example.test/1'
    const { initMonitoring, captureException } = await import('./sentry')
    initMonitoring()

    const error = new Error('boom')
    captureException(error, { username: 'alice', httpStatus: 403 })
    expect(captureExceptionMock).toHaveBeenCalledWith(error, {
      extra: { username: 'alice', httpStatus: 403 },
    })
  })

  it('forwards captured messages with a warning level and extra context when GLITCHTIP_DSN is set', async () => {
    process.env.GLITCHTIP_DSN = 'https://example.test/1'
    const { initMonitoring, captureMessage } = await import('./sentry')
    initMonitoring()

    captureMessage('too many warnings', { username: 'test_user', warningCount: 7 })

    expect(captureMessageMock).toHaveBeenCalledWith('too many warnings', {
      level: 'warning',
      extra: { username: 'test_user', warningCount: 7 },
    })
  })
})
