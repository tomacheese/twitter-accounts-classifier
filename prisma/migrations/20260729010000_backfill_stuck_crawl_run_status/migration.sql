-- Before this change, `startCrawlRun` wrote the placeholder status 'success' (not
-- 'running') at the start of a crawl cycle. Any cycle whose process was killed
-- before finishing (OOM, forced container stop, etc.) was left stuck showing
-- 'success' with no `finishedAt`, which is exactly the misleading state this
-- feature set otherwise fixes going forward. Correct any such rows already in
-- the table: a null `finishedAt` unambiguously means the cycle never completed.
UPDATE "CrawlRun" SET "status" = 'failed' WHERE "finishedAt" IS NULL;
