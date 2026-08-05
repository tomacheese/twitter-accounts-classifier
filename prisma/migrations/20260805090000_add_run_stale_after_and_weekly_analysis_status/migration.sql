ALTER TABLE "CrawlRun" ADD COLUMN "staleAfterAt" TIMESTAMP(3);
ALTER TABLE "BlockRun" ADD COLUMN "staleAfterAt" TIMESTAMP(3);

ALTER TABLE "WeeklyAnalysisRun" ADD COLUMN "lastHeartbeatAt" TIMESTAMP(3);
ALTER TABLE "WeeklyAnalysisRun" ADD COLUMN "staleAfterAt" TIMESTAMP(3);
ALTER TABLE "WeeklyAnalysisRun" ADD COLUMN "status" TEXT;
ALTER TABLE "WeeklyAnalysisRun" ADD COLUMN "currentPhase" TEXT;
ALTER TABLE "WeeklyAnalysisRun" ADD COLUMN "errorMessage" TEXT;
ALTER TABLE "WeeklyAnalysisRun" ADD COLUMN "pullRequestNumber" INTEGER;
ALTER TABLE "WeeklyAnalysisRun" ADD COLUMN "pullRequestUrl" TEXT;

UPDATE "WeeklyAnalysisRun"
SET
  "lastHeartbeatAt" = COALESCE("finishedAt", "startedAt"),
  "status" = CASE WHEN "finishedAt" IS NOT NULL THEN 'success' ELSE 'failed' END
WHERE "lastHeartbeatAt" IS NULL;

DO $$
DECLARE remaining_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO remaining_count FROM "WeeklyAnalysisRun" WHERE "lastHeartbeatAt" IS NULL OR "status" IS NULL;
  IF remaining_count > 0 THEN
    RAISE EXCEPTION 'WeeklyAnalysisRun backfill left % row(s) without lastHeartbeatAt/status', remaining_count;
  END IF;
END $$;

ALTER TABLE "WeeklyAnalysisRun" ALTER COLUMN "lastHeartbeatAt" SET NOT NULL;
ALTER TABLE "WeeklyAnalysisRun" ALTER COLUMN "status" SET NOT NULL;

CREATE INDEX "WeeklyAnalysisRun_status_startedAt_id_idx" ON "WeeklyAnalysisRun"("status", "startedAt" DESC, "id" DESC);
