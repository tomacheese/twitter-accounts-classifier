import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { OperationCycleDetailView } from '@/lib/queries/operation-cycles'
import { OperationCycleDetail } from './cycle-detail-view'

function buildDetail(stages: OperationCycleDetailView['stages']): OperationCycleDetailView {
  return {
    id: 'cycle-1',
    kind: 'crawl',
    status: 'partial',
    attentionRequired: true,
    triggeredAt: new Date('2026-01-01T00:00:00Z'),
    startedAt: new Date('2026-01-01T00:00:00Z'),
    finishedAt: new Date('2026-01-01T00:10:00Z'),
    stages,
  }
}

describe('OperationCycleDetail', () => {
  it('blocked_by_upstream と failed を異なる表示ラベル・色クラスで区別する', () => {
    const detail = buildDetail([
      {
        stageKey: 'crawl',
        sequence: 1,
        requiredness: 'required',
        status: 'failed',
        startedAt: null,
        finishedAt: null,
        errorCode: null,
        errorSummary: 'boom',
      },
      {
        stageKey: 'label_aggregate_refresh',
        sequence: 2,
        requiredness: 'required',
        status: 'blocked_by_upstream',
        startedAt: null,
        finishedAt: null,
        errorCode: null,
        errorSummary: 'work item was never enqueued',
      },
    ])

    const html = renderToStaticMarkup(<OperationCycleDetail detail={detail} />)

    expect(html).toContain('Blocked (upstream failure)')
    expect(html).toContain('bg-gray-100')
    expect(html).toContain('bg-red-100')
    expect(html).not.toContain('blocked_by_upstream')
  })

  it.each([
    ['label_aggregate_snapshot_failed', 'Snapshot aggregation failed'],
    ['label_finding_generation_failed', 'Finding generation failed'],
    ['label_summary_publish_failed', 'Read model publish failed'],
  ] as const)('errorCode が %s なら "%s" を表示する', (errorCode, label) => {
    const detail = buildDetail([
      {
        stageKey: 'label_aggregate_refresh',
        sequence: 1,
        requiredness: 'required',
        status: 'failed',
        startedAt: null,
        finishedAt: null,
        errorCode,
        errorSummary: 'boom',
      },
    ])

    const html = renderToStaticMarkup(<OperationCycleDetail detail={detail} />)

    expect(html).toContain(label)
    expect(html).not.toContain('boom')
  })

  it('未知の errorCode はそのまま表示する', () => {
    const detail = buildDetail([
      {
        stageKey: 'label_aggregate_refresh',
        sequence: 1,
        requiredness: 'required',
        status: 'failed',
        startedAt: null,
        finishedAt: null,
        errorCode: 'unknown_error_code',
        errorSummary: 'boom',
      },
    ])

    const html = renderToStaticMarkup(<OperationCycleDetail detail={detail} />)

    expect(html).toContain('unknown_error_code')
  })
})
