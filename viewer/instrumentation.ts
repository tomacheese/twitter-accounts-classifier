/**
 * Next.js instrumentation hook, invoked once per runtime as the server boots.
 */
export async function register() {
  // This hook runs in both the Node.js and Edge runtimes, but the GlitchTip
  // monitoring it sets up only supports the Node.js runtime this app runs on.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initMonitoring } = await import('./lib/monitoring/sentry')
    initMonitoring()
  }
}
