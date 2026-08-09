import type { PrismaClient } from '../generated/prisma'

/** 自身が属するコンポーネント名。 */
export type ComponentName = 'viewer' | 'crawler' | 'blocker' | 'analyzer'

/**
 * BUILD_TIME 環境変数を Date へ変換する。未設定または ISO 形式として解釈できない値は、
 * Prisma への書き込み時に無効な Date で失敗させるのではなく null として記録する。
 * @param value - `BUILD_TIME` 環境変数の生値
 * @returns 解釈できた Date、できなければ null
 */
function parseBuildTime(value: string | undefined): Date | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * 起動時に自身の build identity を ComponentBuildIdentity へ upsert する。
 * System 画面から4 component の revision 差を一目で確認できるようにするための唯一の書き込み経路。
 * @param prisma - Prisma クライアント
 * @param component - 自身のコンポーネント名
 */
export async function upsertComponentBuildIdentity(
  prisma: PrismaClient,
  component: ComponentName,
): Promise<void> {
  const applicationVersion = process.env.APPLICATION_VERSION ?? 'unknown'
  const gitRevision = process.env.GIT_REVISION ?? 'unknown'
  const buildTime = parseBuildTime(process.env.BUILD_TIME)
  const startedAt = new Date()

  await prisma.componentBuildIdentity.upsert({
    where: { component },
    create: { component, applicationVersion, gitRevision, buildTime, startedAt },
    update: { applicationVersion, gitRevision, buildTime, startedAt },
  })
}
