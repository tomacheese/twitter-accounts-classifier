import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from './load-config'

describe('loadConfig', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('parses a valid config file', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'config-test-'))
    const configPath = path.join(dir, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        accounts: [
          { email: 'a@example.com', username: 'test_user', password: 'secret', otp_secret: null },
        ],
      }),
    )

    const config = loadConfig(configPath)

    expect(config.accounts).toHaveLength(1)
    expect(config.accounts[0]).toEqual({
      email: 'a@example.com',
      username: 'test_user',
      password: 'secret',
      otpSecret: null,
    })
  })

  it('throws a descriptive error when accounts is missing', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'config-test-'))
    const configPath = path.join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({}))

    expect(() => loadConfig(configPath)).toThrow(
      "config must declare at least one account in 'accounts'",
    )
  })

  it('throws a descriptive error when accounts is empty', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'config-test-'))
    const configPath = path.join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ accounts: [] }))

    expect(() => loadConfig(configPath)).toThrow(/accounts/i)
  })
})
