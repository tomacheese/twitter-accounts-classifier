export async function register() {
  // このフックは Node.js と Edge の両方のランタイムで実行されるが、
  // ここで初期化する GlitchTip 連携・DB アクセスは Node.js ランタイムのみ対応しているため、ここで絞り込む。
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initMonitoring, captureException } = await import('./lib/monitoring/sentry')
    initMonitoring()

    // キャッシュのバックグラウンド更新は起動時最適化にすぎないため、
    // ここで失敗してもサーバー起動全体を失敗させない。
    try {
      const { startLatestLabelsSummaryWarming } = await import('./lib/queries/dashboard')
      const { getPrismaClient } = await import('./lib/prisma')
      startLatestLabelsSummaryWarming(getPrismaClient())
    } catch (error) {
      console.error('Failed to start dashboard label summary cache warming:', error)
      captureException(error, { source: 'instrumentation.register' })
    }
  }
}
