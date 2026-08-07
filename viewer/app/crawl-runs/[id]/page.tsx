import { notFound, permanentRedirect } from 'next/navigation'
import Link from 'next/link'
import { formatDateTime } from '@/lib/format-date'
import { isCurrentAccountStale } from '@/lib/crawl-run-progress'
import { formatDuration } from '@/lib/format-duration'
import { getPrismaClient } from '@/lib/prisma'
import { getCrawlRunDetail } from '@/lib/queries/crawl-runs'
import { isNewUiSectionEnabled } from '@/lib/feature-flags'
import { resolveOperationCycleRedirectTarget } from '@/lib/legacy-redirect'
import { ErrorFallback } from '../../components/error-fallback'
import { StatusBadge } from '../../components/status-badge'

/**
 * 旧 `/crawl-runs/[id]` から対応する `/operations/crawl/[cycleId]` へ 308 リダイレクトする。
 * 対応する OperationCycle がまだ存在しない場合は Operations 一覧の Crawl filter へ逃がす。
 * @param id - 旧 CrawlRun の ID (OperationCycle.sourceId と一致する)
 */
async function redirectToOperationsIfEnabled(id: string): Promise<void> {
  if (!isNewUiSectionEnabled('operations')) return

  const target = await resolveOperationCycleRedirectTarget(getPrismaClient(), {
    sourceType: 'crawl_run',
    sourceId: id,
    detailPathPrefix: '/operations/crawl',
    fallbackHref: '/operations?kind=crawl',
  })
  permanentRedirect(target)
}

// このページは処理中アカウントの経過時間などリクエスト時点の値を描画するため、
// 静的プリレンダリングの対象から外している。指定しないと、
// Prisma 経由の読み取りは Next.js のキャッシュ無効化の対象にならず、
// 経過時間などの値が初回レンダー時点のまま固定されてしまう。
export const dynamic = 'force-dynamic'

/** crawler が発行する警告種別。障害の発生箇所ごとに1つ。 */
type CrawlWarningType =
  | 'recommended_timeline_failed'
  | 'following_timeline_failed'
  | 'trending_timeline_failed'
  | 'author_processing_failed'
  | 'own_account_sync_failed'
  | 'following_sync_failed'
  | 'followers_sync_failed'
  | 'blocks_sync_failed'

/**
 * crawler と viewer は TypeScript のプロジェクト参照を共有していない別パッケージのため、
 * crawler/db/crawl-run-repository.ts の CrawlWarning 型をここに複製している。
 */
interface CrawlWarning {
  type: CrawlWarningType
  message: string
  username?: string
  authorId?: string
  errorMessage: string
  /** 失敗の原因になった生の HTTP レスポンス本文。crawler が取得できた場合のみ。 */
  rawResponseSnippet?: string
  /** この警告を生成した crawler のビルド (APPLICATION_VERSION)。 */
  appVersion?: string
}

/**
 * @param warnings - 記録された順のアカウント実行の警告一覧
 * @returns 出現順に並んだ、種別ごとの警告のペア
 */
function groupWarningsByType(warnings: CrawlWarning[]): [CrawlWarningType, CrawlWarning[]][] {
  const groups = new Map<CrawlWarningType, CrawlWarning[]>()
  for (const warning of warnings) {
    const group = groups.get(warning.type) ?? []
    group.push(warning)
    groups.set(warning.type, group)
  }
  return [...groups.entries()]
}

const ACCOUNT_RUN_COLUMNS = [
  'Username',
  'Status',
  'Started at',
  'Finished at',
  'Duration',
  'Recommended timeline tweets',
  'Following timeline tweets',
  'Trending timeline tweets',
  'Replies',
  'Profiles',
  'Labels applied',
  'Following graph synced',
  'Followers graph synced',
  'Blocks synced',
  'Warnings',
  'Error',
] as const

/**
 * @param props - ルートの `id` パスパラメータ
 * @returns クロール実行詳細ページの描画結果
 */
export default async function CrawlRunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<React.ReactElement> {
  const { id } = await params
  await redirectToOperationsIfEnabled(id)

  let run: Awaited<ReturnType<typeof getCrawlRunDetail>>
  try {
    run = await getCrawlRunDetail(getPrismaClient(), id)
  } catch (error) {
    // error.message には SQL 接続情報などドライバー由来の詳細が含まれうるため、
    // 詳細はサーバー側のログにのみ残し、クライアントには一般的なメッセージだけを返す。
    console.error('Failed to load crawl run detail:', error)
    return <ErrorFallback message="Failed to load the crawl run." />
  }
  if (!run) {
    notFound()
  }

  const statusCounts: Partial<Record<string, number>> = {}
  for (const accountRun of run.accountRuns) {
    statusCounts[accountRun.status] = (statusCounts[accountRun.status] ?? 0) + 1
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/crawl-runs" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
        ← Back to crawl runs
      </Link>

      <section className="rounded-lg border bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Crawl run</h1>
          <StatusBadge status={run.status} />
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
          <div>
            <dt className="text-gray-500 dark:text-gray-400">Started at</dt>
            <dd>{formatDateTime(run.startedAt)}</dd>
          </div>
          <div>
            <dt className="text-gray-500 dark:text-gray-400">Finished at</dt>
            <dd>{run.finishedAt ? formatDateTime(run.finishedAt) : '—'}</dd>
          </div>
          <div>
            <dt className="text-gray-500 dark:text-gray-400">Duration</dt>
            <dd>{run.finishedAt ? formatDuration(run.startedAt, run.finishedAt) : '—'}</dd>
          </div>
          <div>
            <dt className="text-gray-500 dark:text-gray-400">Accounts processed</dt>
            <dd>{run.accountRuns.length.toLocaleString()}</dd>
          </div>
          {run.status === 'running' &&
            run.currentUsername &&
            run.currentAccountStartedAt &&
            !isCurrentAccountStale(run.currentAccountStartedAt, new Date()) && (
              <div>
                <dt className="text-gray-500 dark:text-gray-400">Currently processing</dt>
                <dd>
                  @{run.currentUsername} ({formatDuration(run.currentAccountStartedAt, new Date())}{' '}
                  elapsed)
                </dd>
              </div>
            )}
        </dl>
        {run.accountRuns.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2 text-sm">
            {Object.entries(statusCounts).map(([status, count]) => (
              <span key={status} className="flex items-center gap-1">
                <StatusBadge status={status} /> × {count}
              </span>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Accounts</h2>
        {run.accountRuns.length > 0 && (
          <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
            The timeline-tweet columns count tweets fetched this cycle from each timeline; they are
            unrelated to the follow/follower graph. The synced columns report whether that graph
            sync step succeeded — see an account&apos;s own page for its actual following/followers
            counts.
          </p>
        )}
        {run.accountRuns.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No accounts were processed in this run.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-gray-100 text-left dark:bg-gray-700">
                <tr>
                  {ACCOUNT_RUN_COLUMNS.map((column) => (
                    <th key={column} className="p-2">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {run.accountRuns.map((accountRun) => {
                  const warnings = Array.isArray(accountRun.warnings)
                    ? (accountRun.warnings as unknown as CrawlWarning[])
                    : []
                  return (
                    <tr key={accountRun.id} className="border-t dark:border-gray-700">
                      <td className="p-2">{accountRun.username}</td>
                      <td className="p-2">
                        <StatusBadge status={accountRun.status} />
                      </td>
                      <td className="p-2">{formatDateTime(accountRun.startedAt)}</td>
                      <td className="p-2">
                        {accountRun.finishedAt ? formatDateTime(accountRun.finishedAt) : '—'}
                      </td>
                      <td className="p-2">
                        {accountRun.finishedAt
                          ? formatDuration(accountRun.startedAt, accountRun.finishedAt)
                          : '—'}
                      </td>
                      <td className="p-2">{accountRun.recommendedCount}</td>
                      <td className="p-2">{accountRun.followingCount}</td>
                      <td className="p-2">{accountRun.trendingCount}</td>
                      <td className="p-2">{accountRun.replyCount}</td>
                      <td className="p-2">{accountRun.profileCount}</td>
                      <td className="p-2">{accountRun.labelsAppliedCount}</td>
                      <td className="p-2">{accountRun.followingSynced ? 'yes' : 'no'}</td>
                      <td className="p-2">{accountRun.followersSynced ? 'yes' : 'no'}</td>
                      <td className="p-2">{accountRun.blocksSynced ? 'yes' : 'no'}</td>
                      <td className="p-2">
                        {warnings.length === 0 ? (
                          '—'
                        ) : (
                          <details>
                            <summary className="cursor-pointer text-blue-600 hover:underline dark:text-blue-400">
                              {warnings.length} warning(s)
                            </summary>
                            <ul className="mt-1 space-y-1 pl-4">
                              {groupWarningsByType(warnings).map(([type, group]) => (
                                <li key={type}>
                                  <details>
                                    <summary className="cursor-pointer">
                                      {type} × {group.length}
                                    </summary>
                                    <ul className="mt-1 list-disc pl-4">
                                      {group.map((warning, index) => (
                                        // warning には固有の id がなく、
                                        // このリストは並び替えも変更もされないため、
                                        // key に index を使っても問題ない。
                                        <li key={index}>
                                          {warning.message}
                                          {warning.username
                                            ? ` (username: ${warning.username})`
                                            : ''}
                                          {warning.authorId
                                            ? ` (authorId: ${warning.authorId})`
                                            : ''}
                                          {' — '}
                                          {warning.errorMessage}
                                          {warning.appVersion
                                            ? ` (build: ${warning.appVersion})`
                                            : ''}
                                          {warning.rawResponseSnippet && (
                                            <details className="mt-1">
                                              <summary className="cursor-pointer text-blue-600 hover:underline dark:text-blue-400">
                                                Raw response
                                              </summary>
                                              <pre className="mt-1 max-h-64 overflow-auto rounded bg-gray-100 p-2 text-xs whitespace-pre-wrap dark:bg-gray-900">
                                                {warning.rawResponseSnippet}
                                              </pre>
                                            </details>
                                          )}
                                        </li>
                                      ))}
                                    </ul>
                                  </details>
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </td>
                      <td className="p-2">{accountRun.errorMessage ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
