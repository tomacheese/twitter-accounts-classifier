import React from 'react'
import { getPrismaClient } from '@/lib/prisma'
import { getSystemConsoleData } from '@/lib/queries/system-console'
import { formatDateTime } from '@/lib/format-date'
import { ErrorFallback } from '../components/error-fallback'
import { PolicyRawViewer } from './policy-raw-viewer'
import { notFound } from 'next/navigation'
import { isNewUiSectionEnabled } from '@/lib/feature-flags'

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
            <table className="mt-2 w-full text-left text-sm">
              <thead>
                <tr>
                  <th className="p-2">Component</th>
                  <th className="p-2">Application version</th>
                  <th className="p-2">Git revision</th>
                  <th className="p-2">Build time</th>
                  <th className="p-2">Updated at</th>
                </tr>
              </thead>
              <tbody>
                {data.componentBuildIdentities.map((identity) => (
                  <tr key={identity.component} className="border-t dark:border-gray-700">
                    <td className="p-2 font-mono">{identity.component}</td>
                    <td className="p-2">{identity.applicationVersion}</td>
                    <td className="p-2 font-mono">{identity.gitRevision}</td>
                    <td className="p-2">
                      {identity.buildTime ? formatDateTime(identity.buildTime) : '—'}
                    </td>
                    <td className="p-2">{formatDateTime(identity.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
            <table className="mt-2 w-full text-left text-sm">
              <thead>
                <tr>
                  <th className="p-2">Model</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Schema</th>
                  <th className="p-2">Last success</th>
                  <th className="p-2">Stale at</th>
                  <th className="p-2">Error</th>
                </tr>
              </thead>
              <tbody>
                {data.readModels.map((model) => (
                  <tr key={model.modelKey} className="border-t dark:border-gray-700">
                    <td className="p-2 font-mono">{model.modelKey}</td>
                    <td className="p-2">{model.status}</td>
                    <td className="p-2">{model.schemaVersion}</td>
                    <td className="p-2">
                      {model.lastSuccessAt ? formatDateTime(model.lastSuccessAt) : '—'}
                    </td>
                    <td className="p-2">{model.staleAt ? formatDateTime(model.staleAt) : '—'}</td>
                    <td className="p-2">{model.errorSummary ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
