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
 * retention sweep は analyzer ロールで削除する。write allowlist (INSERT/UPDATE/DELETE) に無い表は、
 * DELETE だけを許す GRANT 文に列挙されていないと本番で権限エラーになるため、静的に検証する。
 */
const DELETE_ONLY_TABLES = [
  'AccountClassificationObservation',
  'CrawlAccountCheckpoint',
  'CrawlAuthorCheckpoint',
  'CrawlAccountLabelRun',
]

describe('sync-analyzer-grants.sql と retention sweep の DELETE 対象の整合性', () => {
  it.each(DELETE_ONLY_TABLES)('%s への GRANT ... DELETE を含む', (table) => {
    const grantsSql = readFileSync(GRANTS_SQL_PATH, 'utf8')
    const deleteGrantStatements = grantsSql.match(/GRANT\s+DELETE\b[^;]*;/gs) ?? []

    expect(deleteGrantStatements.some((statement) => statement.includes(`"${table}"`))).toBe(true)
  })
})
