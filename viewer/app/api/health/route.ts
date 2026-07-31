import { NextResponse } from 'next/server'

// Liveness probe only — deliberately does not touch the database.
//
// The Docker healthcheck targets this route rather than '/', whose
// KPI/label-distribution queries scan the whole AccountLabel table and can
// take over 10s under load — far longer than a healthcheck should wait.
// Whether the process is up and serving is a separate question from whether
// one expensive query is currently fast.
export function GET(): NextResponse {
  return NextResponse.json({ status: 'ok' })
}
