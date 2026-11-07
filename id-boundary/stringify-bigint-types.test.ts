import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(
  new URL('../prisma/scripts/stringify-bigint-types.mjs', import.meta.url),
)
const MARKER = '/* id-boundary: bigint is rewritten to string */'

const sample = [
  'export type Account = { id: bigint; name: string; count: number }',
  'export type WhereInput = {',
  '  id?: BigIntFilter<"Account"> | bigint | number',
  '  ids?: bigint[] | number[] | ListBigIntFieldRefInput<$PrismaModel>',
  '  equals?: bigint | number | BigIntFieldRefInput<$PrismaModel>',
  '  maxId: bigint | null',
  '  cursor?: bigint | number | bigint[] | number[]',
  '}',
  '',
].join('\n')

const dirs: string[] = []

function makeOutput(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stringify-bigint-'))
  dirs.push(dir)
  fs.writeFileSync(path.join(dir, 'index.d.ts'), content)
  return dir
}

function run(dir: string): string {
  return execFileSync('node', [script, dir], { encoding: 'utf8' })
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('stringify-bigint-types', () => {
  it('bigint を string に、bigint | number を string に書き換える', () => {
    const dir = makeOutput(sample)
    run(dir)
    expect(fs.readFileSync(path.join(dir, 'index.d.ts'), 'utf8')).toBe(
      [
        MARKER,
        'export type Account = { id: string; name: string; count: number }',
        'export type WhereInput = {',
        '  id?: BigIntFilter<"Account"> | string',
        '  ids?: string[] | ListBigIntFieldRefInput<$PrismaModel>',
        '  equals?: string | BigIntFieldRefInput<$PrismaModel>',
        '  maxId: string | null',
        '  cursor?: string | string[]',
        '}',
        '',
      ].join('\n'),
    )
  })

  it('2 回目の実行では内容を変えない', () => {
    const dir = makeOutput(sample)
    run(dir)
    const once = fs.readFileSync(path.join(dir, 'index.d.ts'), 'utf8')
    expect(run(dir)).toContain('(0 replaced)')
    expect(fs.readFileSync(path.join(dir, 'index.d.ts'), 'utf8')).toBe(once)
  })

  it('bigint が 1 つもない生成物は、生成物の形式が変わったとみなして失敗する', () => {
    const dir = makeOutput('export type Account = { id: string }\n')
    expect(() => run(dir)).toThrow('No bigint found')
  })
})
