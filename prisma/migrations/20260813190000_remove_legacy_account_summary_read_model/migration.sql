DELETE FROM "ReadModelPointer" WHERE "modelKey" = 'account_summary';
DELETE FROM "ReadModelState" WHERE "modelKey" = 'account_summary';
DELETE FROM "ReadModelGeneration" WHERE "modelKey" = 'account_summary';

DROP TABLE "AccountClassificationCurrent";
DROP TABLE "AccountSummaryCurrent";
