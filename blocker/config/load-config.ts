import { readFileSync } from 'node:fs'
import { z } from 'zod'

const rawTargetLabelSchema = z.object({
  label: z.string(),
  confidence_threshold: z.number().min(0).max(1),
})

const rawBlockRuleSchema = z.object({
  target_labels: z.array(rawTargetLabelSchema).min(1),
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
 * 対象ラベル1件分の確信度閾値。
 */
export interface BlockTargetLabel {
  label: string
  confidenceThreshold: number
}

/**
 * ブロック対象を判定するためのラベル閾値ルール。
 */
export interface BlockRuleConfig {
  targetLabels: BlockTargetLabel[]
}

interface BlockerAccountCredentials {
  email: string
  username: string
  password: string
  otpSecret: string | null
}

/**
 * ブロック実行アカウント1件分の設定。
 * `blockEnabled: true` の場合のみ `blockRule` を持つ判別可能ユニオンとすることで、
 * 「有効なのに適用ルールが無い」という状態を型で表現不可能にする
 * (個別ルールとグローバルルールのどちらが解決されたかは呼び出し側が区別する必要が無いため、
 * `loadBlockerConfig` が読み込み時点でどちらか一方に確定させる)。
 */
export type BlockerAccountConfig =
  | (BlockerAccountCredentials & { blockEnabled: true; blockRule: BlockRuleConfig })
  | (BlockerAccountCredentials & { blockEnabled: false })

/**
 * blocker サービス全体の設定。
 */
export interface BlockerAppConfig {
  accounts: BlockerAccountConfig[]
  discordWebhookUrl: string | null
}

function toBlockRuleConfig(raw: z.infer<typeof rawBlockRuleSchema>): BlockRuleConfig {
  return {
    targetLabels: raw.target_labels.map((target) => ({
      label: target.label,
      confidenceThreshold: target.confidence_threshold,
    })),
  }
}

/**
 * @param path - `data/config.json` のパス。省略時は crawler と同じ既定値を使う
 * @returns ブロック機能向けに拡張したアプリ設定
 * @throws `block_enabled: true` のアカウントが `block_rule` もグローバル `block` も持たず、どのルールで判定すべきか決められない場合。
 */
export function loadBlockerConfig(path = 'data/config.json'): BlockerAppConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8'))

  try {
    const parsed = rawConfigSchema.parse(raw)
    const globalBlockRule = parsed.block ? toBlockRuleConfig(parsed.block) : null

    const accounts: BlockerAccountConfig[] = parsed.accounts.map((account) => {
      const blockEnabled = account.block_enabled ?? false
      const credentials: BlockerAccountCredentials = {
        email: account.email,
        username: account.username,
        password: account.password,
        otpSecret: account.otp_secret,
      }
      if (!blockEnabled) {
        return { ...credentials, blockEnabled: false }
      }
      const blockRule = account.block_rule ? toBlockRuleConfig(account.block_rule) : globalBlockRule
      if (!blockRule) {
        throw new Error(
          `Account "${account.username}" has block_enabled=true but no block_rule and no top-level block rule is configured`,
        )
      }
      return { ...credentials, blockEnabled: true, blockRule }
    })

    return {
      accounts,
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
        throw new Error("config must declare at least one account in 'accounts'", { cause: error })
      }
      throw new Error(`Invalid config: ${error.message}`, { cause: error })
    }
    throw error
  }
}
