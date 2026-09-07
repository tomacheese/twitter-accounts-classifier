BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "AccountLabel" RENAME TO "AccountLabelLegacy";
COMMIT;
