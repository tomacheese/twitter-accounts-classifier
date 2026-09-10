BEGIN;
SET LOCAL lock_timeout = '3s';
-- AccountLabelLatest/AccountClassificationLatest は億行規模のため、
-- 対象キー1件分でも通常の DML タイムアウトの想定 (30s) を超えうる。
SET LOCAL statement_timeout = '5min';

-- blue_verified: 独立ルールとしては復活させず正式に廃止する。
-- BlockAction は BlockOutboxEntry を参照しうるため、子(BlockAction)→親(BlockOutboxEntry)の順に削除する。
DELETE FROM "BlockAction"
WHERE "labelDefinitionId" = (SELECT id FROM "LabelDefinition" WHERE key = 'blue_verified');

DELETE FROM "BlockOutboxEntry"
WHERE "labelDefinitionId" = (SELECT id FROM "LabelDefinition" WHERE key = 'blue_verified');

DELETE FROM "AccountLabelChange"
WHERE "labelDefinitionId" = (SELECT id FROM "LabelDefinition" WHERE key = 'blue_verified');

DELETE FROM "AccountClassificationLatest"
WHERE "labelDefinitionId" = (SELECT id FROM "LabelDefinition" WHERE key = 'blue_verified');

DELETE FROM "AccountLabelLatest"
WHERE "labelDefinitionId" = (SELECT id FROM "LabelDefinition" WHERE key = 'blue_verified');

DELETE FROM "LabelDefinition" WHERE key = 'blue_verified';

-- verified_blue_parody_fan: 実際の評価内容が parody_account ルールの出力形式と一致するため統合する。
-- BlockAction/BlockOutboxEntry/AccountLabelChange は labelDefinitionId に対する複合主キー/一意制約を持たないため単純な UPDATE で付け替える。
UPDATE "BlockAction"
SET "labelDefinitionId" = (SELECT id FROM "LabelDefinition" WHERE key = 'parody_account')
WHERE "labelDefinitionId" = (SELECT id FROM "LabelDefinition" WHERE key = 'verified_blue_parody_fan');

UPDATE "BlockOutboxEntry"
SET "labelDefinitionId" = (SELECT id FROM "LabelDefinition" WHERE key = 'parody_account')
WHERE "labelDefinitionId" = (SELECT id FROM "LabelDefinition" WHERE key = 'verified_blue_parody_fan');

UPDATE "AccountLabelChange"
SET "labelDefinitionId" = (SELECT id FROM "LabelDefinition" WHERE key = 'parody_account')
WHERE "labelDefinitionId" = (SELECT id FROM "LabelDefinition" WHERE key = 'verified_blue_parody_fan');

-- AccountLabelLatest/AccountClassificationLatest は (accountId, labelDefinitionId) が主キーのため、
-- 同一アカウントが既に parody_account 側の行を持つ場合は主キー衝突を避けて孤立側を削除し、
-- 衝突しない行のみ付け替える。
DELETE FROM "AccountLabelLatest" orphan
WHERE orphan."labelDefinitionId" = (SELECT id FROM "LabelDefinition" WHERE key = 'verified_blue_parody_fan')
  AND EXISTS (
    SELECT 1 FROM "AccountLabelLatest" existing
    WHERE existing."accountId" = orphan."accountId"
      AND existing."labelDefinitionId" = (SELECT id FROM "LabelDefinition" WHERE key = 'parody_account')
  );

UPDATE "AccountLabelLatest"
SET "labelDefinitionId" = (SELECT id FROM "LabelDefinition" WHERE key = 'parody_account')
WHERE "labelDefinitionId" = (SELECT id FROM "LabelDefinition" WHERE key = 'verified_blue_parody_fan');

DELETE FROM "AccountClassificationLatest" orphan
WHERE orphan."labelDefinitionId" = (SELECT id FROM "LabelDefinition" WHERE key = 'verified_blue_parody_fan')
  AND EXISTS (
    SELECT 1 FROM "AccountClassificationLatest" existing
    WHERE existing."accountId" = orphan."accountId"
      AND existing."labelDefinitionId" = (SELECT id FROM "LabelDefinition" WHERE key = 'parody_account')
  );

UPDATE "AccountClassificationLatest"
SET "labelDefinitionId" = (SELECT id FROM "LabelDefinition" WHERE key = 'parody_account')
WHERE "labelDefinitionId" = (SELECT id FROM "LabelDefinition" WHERE key = 'verified_blue_parody_fan');

DELETE FROM "LabelDefinition" WHERE key = 'verified_blue_parody_fan';

COMMIT;
