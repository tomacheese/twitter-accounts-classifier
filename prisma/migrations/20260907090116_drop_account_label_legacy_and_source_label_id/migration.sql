BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
DROP TABLE "AccountLabelLegacy";
ALTER TABLE "AccountLabelChange" DROP COLUMN "sourceLabelId";
COMMIT;
