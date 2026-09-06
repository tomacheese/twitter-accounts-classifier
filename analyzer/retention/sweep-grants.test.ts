import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// CommonJS を採用する本プロジェクトでは __dirname がモジュールの位置を得る素直な手段である。
// eslint-disable-next-line unicorn/prefer-module
const currentDirname = __dirname
const GRANTS_SQL_PATH = path.join(
  currentDirname,
  '..',
  '..',
  'scripts',
  'db',
  'sync-analyzer-grants.sql',
)

/**
 * sweepAccountClassificationObservations (sweep.ts) は analyzer ロールで
 * "AccountClassificationObservation" へ DELETE する。sync-analyzer-grants.sql の
 * write allowlist に含まれていないと本番で DELETE が権限エラーになるため、
 * DELETE を含む GRANT 文に対象テーブルが列挙されていることを静的に検証する。
 */
describe('sync-analyzer-grants.sql と retention sweep の DELETE 対象の整合性', () => {
  it('AccountClassificationObservation への GRANT ... DELETE を含む', () => {
    const grantsSql = readFileSync(GRANTS_SQL_PATH, 'utf8')
    const deleteGrantStatements = grantsSql.match(/GRANT[^;]*\bDELETE\b[^;]*;/gs) ?? []

    const grantsDeleteOnObservationTable = deleteGrantStatements.some((statement) =>
      statement.includes('"AccountClassificationObservation"'),
    )

    expect(grantsDeleteOnObservationTable).toBe(true)
  })
})
