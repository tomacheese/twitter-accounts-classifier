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

  it('exceptionを捕捉する際、contextをextraへ、fingerprint/tagsをgroupingへそれぞれ渡す', async () => {
    process.env.GLITCHTIP_DSN = 'https://example.test/1'
    const { initMonitoring, captureException } = await import('./sentry')
    initMonitoring()

    const error = new Error('boom')
    captureException(
      error,
      { errorCode: 'label_aggregate_snapshot_failed' },
      { fingerprint: ['label-aggregate-refresh', 'P2028'], tags: { prismaErrorCode: 'P2028' } },
    )

    expect(captureExceptionMock).toHaveBeenCalledWith(error, {
      extra: { errorCode: 'label_aggregate_snapshot_failed' },
      fingerprint: ['label-aggregate-refresh', 'P2028'],
      tags: { prismaErrorCode: 'P2028' },
    })
  })
})
