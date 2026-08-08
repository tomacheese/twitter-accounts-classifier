-- Blocker の終端成功 status は "completed"。旧 analyzer はこれを unknown と解釈していたため、
-- 既存の block stage と cycle を正しい succeeded へ修復する。
UPDATE "OperationStage" AS stage
SET status = 'succeeded'
FROM "OperationCycle" AS cycle, "BlockRun" AS run
WHERE stage."cycleId" = cycle.id
  AND cycle."sourceType" = 'block_run'
  AND cycle."sourceId" = run.id
  AND stage."stageKey" = 'block'
  AND stage.status = 'unknown'
  AND run.status = 'completed';

UPDATE "OperationCycle" AS cycle
SET status = 'succeeded',
    "attentionRequired" = false,
    "currentStageKey" = NULL
FROM "BlockRun" AS run
WHERE cycle."sourceType" = 'block_run'
  AND cycle."sourceId" = run.id
  AND cycle.status = 'unknown'
  AND run.status = 'completed'
  AND NOT EXISTS (
    SELECT 1
    FROM "OperationStage" AS stage
    WHERE stage."cycleId" = cycle.id
      AND stage.status <> 'succeeded'
  );
