import React from 'react'
import { getPrismaClient } from '@/lib/prisma'
import { getSystemConsoleData } from '@/lib/queries/system-console'
import { getRelabelStatus } from '@/lib/queries/relabel-status'
import { formatDateTime } from '@/lib/format-date'
import { ErrorFallback } from '../components/error-fallback'
import { ResponsiveTable, type ResponsiveTableColumn } from '../components/responsive-table'
import { PolicyRawViewer } from './policy-raw-viewer'
import { notFound } from 'next/navigation'
import { isNewUiSectionEnabled } from '@/lib/feature-flags'
import type {
  SystemComponentBuildIdentity,
  SystemReadModelStatus,
} from '@/lib/queries/system-console'
import type { RelabelLabelCoverage, RelabelBacklogEntry } from '@/lib/queries/relabel-status'

const componentBuildIdentityColumns: ResponsiveTableColumn<SystemComponentBuildIdentity>[] = [
  {
    key: 'component',
    header: 'Component',
    priority: 'primary',
    render: (identity) => <span className="font-mono">{identity.component}</span>,
  },
  {
    key: 'applicationVersion',
    header: 'Application version',
    priority: 'primary',
    render: (identity) => identity.applicationVersion,
  },
  {
    key: 'gitRevision',
    header: 'Git revision',
    priority: 'secondary',
    render: (identity) => <span className="font-mono">{identity.gitRevision}</span>,
  },
  {
    key: 'buildTime',
    header: 'Build time',
    priority: 'secondary',
    render: (identity) => (identity.buildTime ? formatDateTime(identity.buildTime) : '—'),
  },
  {
    key: 'updatedAt',
    header: 'Updated at',
    priority: 'secondary',
    render: (identity) => formatDateTime(identity.updatedAt),
  },
]

const readModelColumns: ResponsiveTableColumn<SystemReadModelStatus>[] = [
  {
    key: 'model',
    header: 'Model',
    priority: 'primary',
    render: (model) => <span className="font-mono">{model.modelKey}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    priority: 'primary',
    render: (model) => model.status,
  },
  {
    key: 'schema',
    header: 'Schema',
    priority: 'secondary',
    render: (model) => model.schemaVersion,
  },
  {
    key: 'lastSuccess',
    header: 'Last success',
    priority: 'secondary',
    render: (model) => (model.lastSuccessAt ? formatDateTime(model.lastSuccessAt) : '—'),
  },
  {
    key: 'staleAt',
    header: 'Stale at',
    priority: 'secondary',
    render: (model) => (model.staleAt ? formatDateTime(model.staleAt) : '—'),
  },
  {
    key: 'error',
    header: 'Error',
    priority: 'secondary',
    render: (model) => model.errorSummary ?? '—',
  },
]

const relabelCoverageColumns: ResponsiveTableColumn<RelabelLabelCoverage>[] = [
  {
    key: 'key',
    header: 'Label',
    priority: 'primary',
    render: (coverage) => <span className="font-mono">{coverage.key}</span>,
  },
  {
    key: 'currentRuleVersion',
    header: 'Current rule version',
    priority: 'primary',
    render: (coverage) => coverage.currentRuleVersion ?? '—',
  },
  {
    key: 'coverage',
    header: 'Coverage',
    priority: 'primary',
    render: (coverage) => `${coverage.coveredAccounts} / ${coverage.totalAccounts}`,
  },
  {
    key: 'description',
    header: 'Description',
    priority: 'secondary',
    render: (coverage) => coverage.description,
  },
]

const relabelBacklogColumns: ResponsiveTableColumn<RelabelBacklogEntry>[] = [
  {
    key: 'status',
    header: 'Status',
    priority: 'primary',
    render: (entry) => entry.status,
  },
  {
    key: 'count',
    header: 'Count',
    priority: 'primary',
    render: (entry) => entry.count,
  },
]

// 指定しないと、DB 接続がないビルド時に next build が静的生成を試みてしまう。
export const dynamic = 'force-dynamic'

/**
 * System 画面。Component health は Overview が保存した値をそのまま読み、
 * ここでは再計算しない。
 * @returns 描画された System 画面
 */
export default async function SystemPage(): Promise<React.ReactElement> {
  if (!isNewUiSectionEnabled('system')) notFound()

  const prisma = getPrismaClient()
  try {
    const data = await getSystemConsoleData(prisma)
    // Relabel backfill セクションの失敗で画面全体を落とさないよう、他セクションの取得とは
    // 分離して自身の catch で null にフォールバックする。
    const relabelStatus = await getRelabelStatus(prisma).catch((error: unknown) => {
      console.error('Failed to load the relabel status data:', error)
      return null
    })

    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold">System</h1>

        <section aria-labelledby="system-identity-heading">
          <h2 id="system-identity-heading" className="text-lg font-semibold">
            System identity
          </h2>
          <p className="mt-2">
            Version: {data.identity.applicationVersion}, environment: {data.identity.environment}
          </p>
        </section>

        <section aria-labelledby="component-build-identity-heading">
          <h2 id="component-build-identity-heading" className="text-lg font-semibold">
            Component build identity
          </h2>
          {data.componentBuildIdentities.length === 0 ? (
            <p className="mt-2">No component has recorded a build identity yet.</p>
          ) : (
            <div className="mt-2">
              <ResponsiveTable
                columns={componentBuildIdentityColumns}
                rows={data.componentBuildIdentities}
                rowKey={(identity) => identity.component}
              />
            </div>
          )}
        </section>

        <section aria-labelledby="component-health-heading">
          <h2 id="component-health-heading" className="text-lg font-semibold">
            Component health
          </h2>
          {data.componentHealth ? (
            <p className="mt-2">
              Operational: {data.componentHealth.operationalStatus}, quality:{' '}
              {data.componentHealth.qualityStatus} (as of{' '}
              {formatDateTime(data.componentHealth.generatedAt)})
            </p>
          ) : (
            <p className="mt-2">No OverviewSnapshot recorded yet.</p>
          )}
        </section>

        <section aria-labelledby="pipeline-health-heading">
          <h2 id="pipeline-health-heading" className="text-lg font-semibold">
            Pipeline health
          </h2>
          <p className="mt-2">
            Overall: {data.pipelineHealth.overallStatus}, primary cause:{' '}
            {data.pipelineHealth.primaryCause ?? '—'}
          </p>
          <dl className="mt-2 grid gap-2 sm:grid-cols-3">
            <div>
              <dt className="font-medium">Source</dt>
              <dd>
                {data.pipelineHealth.source.status} ({data.pipelineHealth.source.lastOutcome ?? '—'}
                )
              </dd>
            </div>
            <div>
              <dt className="font-medium">Detector</dt>
              <dd>{data.pipelineHealth.detector.status}</dd>
            </div>
            <div>
              <dt className="font-medium">Projection</dt>
              <dd>{data.pipelineHealth.projection.status}</dd>
            </div>
          </dl>
          {data.pipelineHealth.detector.errorSummary ? (
            <p className="mt-2 text-sm text-red-700 dark:text-red-300">
              Detector error: {data.pipelineHealth.detector.errorSummary}
            </p>
          ) : null}
        </section>

        <section aria-labelledby="active-policy-heading">
          <h2 id="active-policy-heading" className="text-lg font-semibold">
            Active policy
          </h2>
          {data.activePolicy ? (
            <div className="mt-2 flex flex-col gap-2">
              <p>
                Version: {data.activePolicy.policyVersion}, schema:{' '}
                {data.activePolicy.schemaVersion}, loaded{' '}
                {formatDateTime(data.activePolicy.loadedAt)}
              </p>
              <p className="break-all text-sm text-gray-600 dark:text-gray-400">
                Content hash: {data.activePolicy.contentHash}
              </p>
              <PolicyRawViewer />
            </div>
          ) : (
            <p className="mt-2">No policy version recorded yet.</p>
          )}
        </section>

        <section aria-labelledby="read-model-status-heading">
          <h2 id="read-model-status-heading" className="text-lg font-semibold">
            Read model status
          </h2>
          {data.readModels.length === 0 ? (
            <p className="mt-2">No read models recorded yet.</p>
          ) : (
            <div className="mt-2">
              <ResponsiveTable
                columns={readModelColumns}
                rows={data.readModels}
                rowKey={(model) => model.modelKey}
              />
            </div>
          )}
        </section>

        <section aria-labelledby="relabel-backfill-heading">
          <h2 id="relabel-backfill-heading" className="text-lg font-semibold">
            Relabel backfill
          </h2>
          {relabelStatus === null ? (
            <p className="mt-2">Failed to load the relabel status data.</p>
          ) : (
            <>
              <p className="mt-2">
                Last scan cursor update:{' '}
                {relabelStatus.scanCursorUpdatedAt
                  ? formatDateTime(relabelStatus.scanCursorUpdatedAt)
                  : '—'}
              </p>
              {relabelStatus.labelCoverage.length === 0 ? (
                <p className="mt-2">No label definition recorded yet.</p>
              ) : (
                <div className="mt-2">
                  <ResponsiveTable
                    columns={relabelCoverageColumns}
                    rows={relabelStatus.labelCoverage}
                    rowKey={(coverage) => coverage.key}
                  />
                </div>
              )}
              {relabelStatus.backlog.length === 0 ? (
                <p className="mt-2">No account_relabel backlog.</p>
              ) : (
                <div className="mt-2">
                  <ResponsiveTable
                    columns={relabelBacklogColumns}
                    rows={relabelStatus.backlog}
                    rowKey={(entry) => entry.status}
                  />
                </div>
              )}
            </>
          )}
        </section>

        <section aria-labelledby="diagnostics-heading">
          <h2 id="diagnostics-heading" className="text-lg font-semibold">
            Diagnostics
          </h2>
          {data.diagnosticsEnvVars.length === 0 ? (
            <p className="mt-2">No diagnostics environment variables to show.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1 font-mono text-sm">
              {data.diagnosticsEnvVars.map((entry) => (
                <li key={entry.key} className="break-all">
                  {entry.key}={entry.value}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    )
  } catch (error) {
    console.error('Failed to load the system console data:', error)
    return <ErrorFallback message="Failed to load the system console data." />
  }
}
