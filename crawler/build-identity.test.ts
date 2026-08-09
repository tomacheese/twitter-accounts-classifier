import { describe, expect, it, vi } from 'vitest'
import { upsertComponentBuildIdentity } from './build-identity'

function createMockPrisma() {
  return {
    componentBuildIdentity: { upsert: vi.fn().mockResolvedValue(undefined) },
  }
}

describe('upsertComponentBuildIdentity', () => {
  it('環境変数から component の build identity を upsert する', async () => {
    vi.stubEnv('APPLICATION_VERSION', '1.2.3')
    vi.stubEnv('GIT_REVISION', 'abcdef0')
    vi.stubEnv('BUILD_TIME', '2026-08-01T00:00:00.000Z')
    const prisma = createMockPrisma()

    await upsertComponentBuildIdentity(prisma as never, 'crawler')

    expect(prisma.componentBuildIdentity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { component: 'crawler' },
        create: expect.objectContaining({
          component: 'crawler',
          applicationVersion: '1.2.3',
          gitRevision: 'abcdef0',
          buildTime: new Date('2026-08-01T00:00:00.000Z'),
        }),
      }),
    )
  })

  it('環境変数が未設定なら unknown を記録し buildTime は null にする', async () => {
    vi.stubEnv('APPLICATION_VERSION', undefined)
    vi.stubEnv('GIT_REVISION', undefined)
    vi.stubEnv('BUILD_TIME', undefined)
    const prisma = createMockPrisma()

    await upsertComponentBuildIdentity(prisma as never, 'crawler')

    expect(prisma.componentBuildIdentity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          applicationVersion: 'unknown',
          gitRevision: 'unknown',
          buildTime: null,
        }),
      }),
    )
  })

  it('BUILD_TIME が ISO 形式で解釈できない場合 buildTime は null にする', async () => {
    vi.stubEnv('APPLICATION_VERSION', '1.2.3')
    vi.stubEnv('GIT_REVISION', 'abcdef0')
    vi.stubEnv('BUILD_TIME', 'not-a-date')
    const prisma = createMockPrisma()

    await upsertComponentBuildIdentity(prisma as never, 'crawler')

    expect(prisma.componentBuildIdentity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ buildTime: null }),
      }),
    )
  })
})
