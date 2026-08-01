import { NextResponse } from 'next/server'

// Liveness probe only — deliberately does not touch the database.
//
// The Docker healthcheck targets this route rather than '/', whose
// KPI/label-distribution queries read AccountLabelLatest but can still stall
// under unrelated disk I/O contention or during a rollout where the table's
// migration hasn't landed yet — longer than a healthcheck should wait.
// Whether the process is up and serving is a separate question from whether
// one such query is currently fast.
export function GET(): NextResponse {
  return NextResponse.json({ status: 'ok' })
}
