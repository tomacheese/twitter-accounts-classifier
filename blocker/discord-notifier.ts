import { Logger } from '@book000/node-utils'

const logger = Logger.configure('discord-notifier')

export interface AccountRunSummary {
  username: string
  blockedCount: number
  failedCount: number
  /**
   * サイクル自体が完走できなかった (認証・own account 解決などで異常終了した) ことを示す。
   * `blockedCount`/`failedCount` が両方 0 でも「対象が単に無かった」場合と区別する必要がある。
   */
  failed: boolean
}

function buildMessageContent(summaries: AccountRunSummary[]): string {
  const totalBlocked = summaries.reduce((sum, summary) => sum + summary.blockedCount, 0)
  const totalFailed = summaries.reduce((sum, summary) => sum + summary.failedCount, 0)

  const lines = [
    `合計: ${totalBlocked} 件ブロック, ${totalFailed} 件失敗`,
    ...summaries.map((summary) => {
      const suffix = summary.failed ? ' (サイクル異常終了)' : ''
      return `- ${summary.username}: ${summary.blockedCount} 件ブロック, ${summary.failedCount} 件失敗${suffix}`
    }),
  ]
  return lines.join('\n')
}

/**
 * 通知の送信失敗はブロック処理の成否に影響させたくないため、この関数自身は throw しない。
 * @param webhookUrl - Discord Webhook URL。null なら送信をスキップする
 * @param summaries - アカウントごとのブロック件数・失敗件数
 * @param fetchImpl - リクエスト送信に使う fetch 実装 (省略時は標準の `fetch`)
 */
export async function notifyDiscord(
  webhookUrl: string | null,
  summaries: AccountRunSummary[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!webhookUrl) return

  try {
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: buildMessageContent(summaries) }),
    })
    if (!response.ok) {
      logger.warn(`Discord webhook responded with HTTP ${response.status}`)
    }
  } catch (error) {
    logger.warn('Failed to send Discord notification', error as Error)
  }
}
