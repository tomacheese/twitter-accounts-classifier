import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadBlockerConfig, resolveBlockRule } from './load-config'

let tempDir: string

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
})

function writeConfig(content: unknown): string {
  tempDir = mkdtempSync(path.join(tmpdir(), 'blocker-config-'))
  const configPath = path.join(tempDir, 'config.json')
  writeFileSync(configPath, JSON.stringify(content))
  return configPath
}

describe('loadBlockerConfig', () => {
  it('defaults block_enabled to false and block_rule to null when omitted', () => {
    const path = writeConfig({
      accounts: [{ email: 'a@example.com', username: 'alice', password: 'p', otp_secret: null }],
    })

    const config = loadBlockerConfig(path)

    expect(config.accounts[0].blockEnabled).toBe(false)
    expect(config.accounts[0].blockRule).toBeNull()
    expect(config.globalBlockRule).toBeNull()
    expect(config.discordWebhookUrl).toBeNull()
  })

  it('parses block_enabled, block_rule, top-level block, and discord_webhook_url', () => {
    const path = writeConfig({
      accounts: [
        {
          email: 'a@example.com',
          username: 'alice',
          password: 'p',
          otp_secret: null,
          block_enabled: true,
          block_rule: { target_labels: ['spam', 'bot'], confidence_threshold: 0.9 },
        },
        { email: 'b@example.com', username: 'bob', password: 'p', otp_secret: null },
      ],
      block: { target_labels: ['spam'], confidence_threshold: 0.8 },
      discord_webhook_url: 'https://discord.example.com/webhooks/exampleXXXX',
    })

    const config = loadBlockerConfig(path)

    expect(config.accounts[0]).toMatchObject({
      blockEnabled: true,
      blockRule: { targetLabels: ['spam', 'bot'], confidenceThreshold: 0.9 },
    })
    expect(config.globalBlockRule).toEqual({ targetLabels: ['spam'], confidenceThreshold: 0.8 })
    expect(config.discordWebhookUrl).toBe('https://discord.example.com/webhooks/exampleXXXX')
  })

  it('rejects a config where block_enabled is true but no block_rule nor top-level block exists', () => {
    const path = writeConfig({
      accounts: [
        {
          email: 'a@example.com',
          username: 'alice',
          password: 'p',
          otp_secret: null,
          block_enabled: true,
        },
      ],
    })

    expect(() => loadBlockerConfig(path)).toThrow(/block_rule/)
  })
})

describe('resolveBlockRule', () => {
  it('prefers the per-account rule over the global rule', () => {
    const config = loadBlockerConfig(
      writeConfig({
        accounts: [
          {
            email: 'a@example.com',
            username: 'alice',
            password: 'p',
            otp_secret: null,
            block_enabled: true,
            block_rule: { target_labels: ['bot'], confidence_threshold: 0.95 },
          },
        ],
        block: { target_labels: ['spam'], confidence_threshold: 0.8 },
      }),
    )

    expect(resolveBlockRule(config.accounts[0], config)).toEqual({
      targetLabels: ['bot'],
      confidenceThreshold: 0.95,
    })
  })

  it('falls back to the global rule when the account has none', () => {
    const config = loadBlockerConfig(
      writeConfig({
        accounts: [
          {
            email: 'a@example.com',
            username: 'alice',
            password: 'p',
            otp_secret: null,
            block_enabled: true,
          },
        ],
        block: { target_labels: ['spam'], confidence_threshold: 0.8 },
      }),
    )

    expect(resolveBlockRule(config.accounts[0], config)).toEqual({
      targetLabels: ['spam'],
      confidenceThreshold: 0.8,
    })
  })
})
