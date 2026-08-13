-- label finding detector の状態は DetectorState へ移行済みのため、ReadModelState を
-- freshness updater や System コンソールの read model 一覧で二重に扱わない。
DELETE FROM "ReadModelState" WHERE "modelKey" = 'label_findings';
