-- CreateIndex: account_summary build の retry で同じ CrawlRun の差分を重複挿入しないための一意制約。
-- sourceId が NULL の行同士は Postgres の仕様上重複と判定されないため、
-- 直接呼び出し(sourceId 未指定)にはこの制約は効かない。
CREATE UNIQUE INDEX "AccountLabelChange_sourceId_accountId_labelDefinitionId_key" ON "AccountLabelChange"("sourceId", "accountId", "labelDefinitionId");
