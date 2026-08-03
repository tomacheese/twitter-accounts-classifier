import Link from 'next/link'

/**
 * @returns クロールラン詳細ページ向けの not-found メッセージ
 */
export default function CrawlRunNotFound(): React.ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Crawl run not found</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400">No crawl run found with that ID.</p>
      <Link href="/crawl-runs" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
        ← Back to crawl runs
      </Link>
    </div>
  )
}
