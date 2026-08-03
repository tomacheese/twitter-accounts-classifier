export async function register() {
  // このフックは Node.js と Edge の両方のランタイムで実行されるが、
  // ここで初期化する GlitchTip 連携・DB アクセスは Node.js ランタイムのみ対応しているため、ここで絞り込む。
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initMonitoring } = await import('./lib/monitoring/sentry')
    initMonitoring()

    const { startLatestLabelsSummaryWarming } = await import('./lib/queries/dashboard')
    const { getPrismaClient } = await import('./lib/prisma')
    startLatestLabelsSummaryWarming(getPrismaClient())
  }
}
