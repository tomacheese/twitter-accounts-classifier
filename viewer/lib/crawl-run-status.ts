/**
 * クロール側が書き込む `CrawlRun`/`CrawlAccountRun` のステータス値。
 * Prisma 側の列は DB の enum ではなく単なる文字列であるため、
 * この型は既知の値を扱うための viewer 側の便宜的なものに過ぎない。
 * 未知の文字列も実行時には有効な値になり得るため、
 * 呼び出し側はこの型で網羅的だと仮定してはならない。
 */
export type CrawlRunStatus = 'running' | 'success' | 'partial' | 'failed'
