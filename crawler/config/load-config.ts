import { readFileSync } from 'node:fs'
import { z } from 'zod'

const rawAccountSchema = z.object({
  email: z.string(),
  username: z.string(),
  password: z.string(),
  otp_secret: z.string().nullable(),
})

const rawConfigSchema = z.object({
  accounts: z.array(rawAccountSchema).min(1, 'config must declare at least one account'),
})

export interface TwitterAccountConfig {
  email: string
  username: string
  password: string
  otpSecret: string | null
}

export interface AppConfig {
  accounts: TwitterAccountConfig[]
}

export function loadConfig(path = 'data/config.json'): AppConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8'))

  try {
    const parsed = rawConfigSchema.parse(raw)
    return {
      accounts: parsed.accounts.map((account) => ({
        email: account.email,
        username: account.username,
        password: account.password,
        otpSecret: account.otp_secret,
      })),
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      const accountsIssue = error.issues.find(
        (issue) =>
          issue.path.length === 1 &&
          issue.path[0] === 'accounts' &&
          (issue.code === 'too_small' ||
            (issue.code === 'invalid_type' && issue.received === 'undefined')),
      )
      if (accountsIssue) {
        throw new Error("config must declare at least one account in 'accounts'")
      }
      throw new Error(`Invalid config: ${error.message}`)
    }
    throw error
  }
}
