export async function register() {
  // このフックは Node.js と Edge の両方のランタイムで実行されるが、
  // ここで行う GlitchTip 連携・build identity 記録は Node.js ランタイムのみ対応のため、
  // ここで絞り込む。
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initMonitoring } = await import('./lib/monitoring/sentry')
    initMonitoring()

    const { getPrismaClient } = await import('./lib/prisma')
    const { upsertComponentBuildIdentity } = await import('./lib/build-identity')
    try {
      await upsertComponentBuildIdentity(getPrismaClient(), 'viewer')
    } catch (error) {
      // build identity 記録は起動時の付随処理であり、DB 不調時に viewer 本体の起動まで止める必要はない。
      console.error('Failed to record the viewer build identity:', error)
    }
  }
}
