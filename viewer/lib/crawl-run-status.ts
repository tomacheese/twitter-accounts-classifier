/**
 * The `CrawlRun`/`CrawlAccountRun` status values written by the crawler. The
 * underlying Prisma column is a plain string, not a database enum, so this type is
 * a viewer-side convenience for known values only - any other string is still a
 * valid runtime value and callers should not assume exhaustiveness against it.
 */
export type CrawlRunStatus = 'running' | 'success' | 'partial' | 'failed'
