import { readFileSync } from 'node:fs'
import { z } from 'zod'

const rawBlockRuleSchema = z.object({
  target_labels: z.array(z.string()).min(1),
  confidence_threshold: z.number().min(0).max(1),
})

const rawAccountSchema = z.object({
  email: z.string(),
  username: z.string(),
  password: z.string(),
  otp_secret: z.string().nullable(),
  block_enabled: z.boolean().optional(),
  block_rule: rawBlockRuleSchema.optional(),
})

const rawConfigSchema = z.object({
  accounts: z.array(rawAccountSchema).min(1, 'config must declare at least one account'),
  block: rawBlockRuleSchema.optional(),
  discord_webhook_url: z.string().optional(),
})

/**
 * ブロック対象を判定するためのラベル閾値ルール。
 */
export interface BlockRuleConfig {
  targetLabels: string[]
  confidenceThreshold: number
}

/**
 * ブロック実行アカウント1件分の設定。
 */
export interface BlockerAccountConfig {
  email: string
  username: string
  password: string
  otpSecret: string | null
  blockEnabled: boolean
  blockRule: BlockRuleConfig | null
}

/**
 * blocker サービス全体の設定。
 */
export interface BlockerAppConfig {
  accounts: BlockerAccountConfig[]
  globalBlockRule: BlockRuleConfig | null
  discordWebhookUrl: string | null
}

function toBlockRuleConfig(raw: z.infer<typeof rawBlockRuleSchema>): BlockRuleConfig {
  return { targetLabels: raw.target_labels, confidenceThreshold: raw.confidence_threshold }
}

/**
 * @param path - `data/config.json` のパス。省略時は crawler と同じ既定値を使う
 * @returns ブロック機能向けに拡張したアプリ設定
 * @throws `block_enabled: true` のアカウントが `block_rule` もグローバル `block` も持たない場合。
 * どのルールで判定すべきか決められない設定エラーを起動時に検出するため。
 */
export function loadBlockerConfig(path = 'data/config.json'): BlockerAppConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8'))

  try {
    const parsed = rawConfigSchema.parse(raw)
    const globalBlockRule = parsed.block ? toBlockRuleConfig(parsed.block) : null

    const accounts = parsed.accounts.map((account) => {
      const blockEnabled = account.block_enabled ?? false
      const blockRule = account.block_rule ? toBlockRuleConfig(account.block_rule) : null
      if (blockEnabled && !blockRule && !globalBlockRule) {
        throw new Error(
          `Account "${account.username}" has block_enabled=true but no block_rule and no top-level block rule is configured`,
        )
      }
      return {
        email: account.email,
        username: account.username,
        password: account.password,
        otpSecret: account.otp_secret,
        blockEnabled,
        blockRule,
      }
    })

    return {
      accounts,
      globalBlockRule,
      discordWebhookUrl: parsed.discord_webhook_url ?? null,
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

/**
 * @param account - ルール解決対象のアカウント
 * @param config - `loadBlockerConfig` が返したアプリ設定
 * @returns アカウント個別のルールがあればそれ、なければグローバルルール
 * @throws どちらも存在しない場合。`loadBlockerConfig` が起動時に同条件を検出するため、
 * ここに到達するのは呼び出し側が古い config オブジェクトを保持している場合のみ。
 */
export function resolveBlockRule(
  account: BlockerAccountConfig,
  config: BlockerAppConfig,
): BlockRuleConfig {
  const rule = account.blockRule ?? config.globalBlockRule
  if (!rule) {
    throw new Error(`No block rule resolved for account "${account.username}"`)
  }
  return rule
}
