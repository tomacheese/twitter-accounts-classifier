import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(process.cwd(), '..')
const packages = ['crawler', 'analyzer', 'viewer', 'blocker'] as const

interface PackageJson {
  scripts?: Record<string, string>
}

describe('workspace package check prerequisites', () => {
  it.each(packages)('%s check regenerates its Prisma client first', (packageName) => {
    const packageJson = JSON.parse(
      readFileSync(path.resolve(root, packageName, 'package.json'), 'utf8'),
    ) as PackageJson

    expect(packageJson.scripts?.['db:generate']).toBeTruthy()
    expect(packageJson.scripts?.precheck).toBe('pnpm run db:generate')
  })
})
