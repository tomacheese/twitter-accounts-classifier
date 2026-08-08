import { Prisma, type PrismaClient } from '../generated/prisma'

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 }

const MODEL_KEY = 'account_summary'

/** watermark 時点でのラベル値 1 件。 */
interface LabelAtWatermark {
  accountId: string
  labelDefinitionId: string
  value: boolean
  confidence: number
  reason: string
  labeledAt: Date
}

/**
 * AccountLabelLatest は常に現在値しか持たないため、そこから読むと
 * backlog 処理中の古い watermark の generation に、その後の crawl/relabel の結果が混ざる。
 * 変更のたびに履歴が積まれる AccountLabel から watermark 時点の値を復元する。
 * @param prisma - Prisma クライアント
 * @param accountIds - 対象ページの Account ID
 * @param sourceWatermarkAt - 集計の基準時刻
 * @returns watermark 時点で有効だったラベル値 (true/false 問わず全件)
 */
async function findLabelsAtWatermark(
  prisma: PrismaClient,
  accountIds: string[],
  sourceWatermarkAt: Date,
): Promise<LabelAtWatermark[]> {
  if (accountIds.length === 0) return []
  return prisma.$queryRaw<LabelAtWatermark[]>`
    SELECT DISTINCT ON ("accountId", "labelDefinitionId")
      "accountId", "labelDefinitionId", "value", "confidence", "reason", "labeledAt"
    FROM "AccountLabel"
    WHERE "accountId" IN (${Prisma.join(accountIds)})
      AND "labeledAt" <= ${sourceWatermarkAt}
    ORDER BY "accountId", "labelDefinitionId", "labeledAt" DESC, "id" DESC
  `
}

/**
 * AccountLabel は値・confidence・reason・ruleVersion のいずれかが変わった回にしか
 * 行を積まないため、ある account+label の直前の行は必ずその変化の「変化前の値」を表す。
 * ANALYZER_WORKER_CONCURRENCY > 1 の並行 build は、この直前行との比較だけで
 * 変化イベントの内容 (previousValue/newValue と、その原因になった labeledAt) を
 * 一意に復元できる。generation のスナップショット同士を比較する方式と異なり、
 * 「どの世代が current になっているか」に依存しないため、
 * 新旧 build が異なる順序で commit してもイベントの向きが逆転しない。
 * @param prisma - Prisma クライアント
 * @param accountIds - 対象ページの Account ID
 * @param sourceWatermarkAt - 集計の基準時刻
 * @returns account+label ごとの直前のラベル値。履歴がまだ無ければ含まれない
 */
async function findPreviousLabelsAtWatermark(
  prisma: PrismaClient,
  accountIds: string[],
  sourceWatermarkAt: Date,
): Promise<LabelAtWatermark[]> {
  if (accountIds.length === 0) return []
  return prisma.$queryRaw<LabelAtWatermark[]>`
    SELECT "accountId", "labelDefinitionId", "value", "confidence", "reason", "labeledAt"
    FROM (
      SELECT "accountId", "labelDefinitionId", "value", "confidence", "reason", "labeledAt",
        ROW_NUMBER() OVER (
          PARTITION BY "accountId", "labelDefinitionId"
          ORDER BY "labeledAt" DESC, "id" DESC
        ) AS rn
      FROM "AccountLabel"
      WHERE "accountId" IN (${Prisma.join(accountIds)})
        AND "labeledAt" <= ${sourceWatermarkAt}
    ) ranked
    WHERE rn = 2
  `
}

/** watermark 時点で active だった Finding 1 件。 */
interface ActiveFindingAtWatermark {
  primaryScopeId: string
  severity: string
}

/** ReviewFindingOccurrence.stateTransition のうち、Finding が open 状態であることを表す値。 */
const OPEN_STATE_TRANSITIONS = new Set(['active', 'recurring', 'new_episode'])

/**
 * ReviewFinding.status は現在値しか持たないため、そこから読むと backlog 処理中の
 * 古い watermark の generation に、その後の Finding 状態変化が混ざる。
 * ReviewFindingOccurrence は sourceObservedAt (元データ自体の時刻) ごとの状態遷移を
 * 積み上げた履歴のため、findingId ごとに watermark 以前で最新の occurrence を取り、
 * その stateTransition から watermark 時点で active だったかを復元する。observedAt
 * (analyzer の処理時刻) で比較すると、同じ crawl から生成された Occurrence でも
 * 処理が遅れて sourceWatermarkAt を追い越し、その crawl 自身の AccountSummary から
 * 漏れてしまう。
 * @param prisma - Prisma クライアント
 * @param accountIds - 対象ページの Account ID
 * @param sourceWatermarkAt - 集計の基準時刻
 * @returns watermark 時点で active だった Finding の scope と severity
 */
async function findActiveFindingsAtWatermark(
  prisma: PrismaClient,
  accountIds: string[],
  sourceWatermarkAt: Date,
): Promise<ActiveFindingAtWatermark[]> {
  if (accountIds.length === 0) return []
  const rows = await prisma.$queryRaw<
    { primaryScopeId: string; severity: string; stateTransition: string }[]
  >`
    SELECT DISTINCT ON (o."findingId")
      f."primaryScopeId", o."severity", o."stateTransition"
    FROM "ReviewFindingOccurrence" o
    JOIN "ReviewFinding" f ON f.id = o."findingId"
    WHERE f."primaryScopeType" = 'account'
      AND f."primaryScopeId" IN (${Prisma.join(accountIds)})
      AND o."sourceObservedAt" <= ${sourceWatermarkAt}
    ORDER BY o."findingId", o."sourceObservedAt" DESC, o.id DESC
  `
  return rows
    .filter((row) => OPEN_STATE_TRANSITIONS.has(row.stateTransition))
    .map((row) => ({ primaryScopeId: row.primaryScopeId, severity: row.severity }))
}

/**
 * buildAccountSummary の入力。
 */
export interface BuildAccountSummaryInput {
  /** 書き込み先の generationId。 */
  generationId: string
  /** 集計の基準時刻。 */
  sourceWatermarkAt: Date
  /** この build の契機となった CrawlRun 等の ID。AccountLabelChange の由来として記録するのみで、重複挿入防止には使わない (accountId+labelDefinitionId+changedAt の一意制約に委ねる)。 */
  sourceCrawlRunId?: string
  /** 1 ページあたりの Account 取得件数。 */
  pageSize?: number
}

/**
 * @param a - 比較対象の severity (null は severity なし扱い)
 * @param b - 比較対象の severity
 * @returns より深刻な方の severity
 */
function maxSeverity(a: string | null, b: string): string {
  if (!a) return b
  return (SEVERITY_RANK[a] ?? 0) >= (SEVERITY_RANK[b] ?? 0) ? a : b
}

/**
 * @param accountId - アカウント ID
 * @param labelDefinitionId - LabelDefinition の ID
 * @returns Map のキー
 */
function classificationKey(accountId: string, labelDefinitionId: string): string {
  return `${accountId} ${labelDefinitionId}`
}

/** 前世代から引き継ぐ分類状態。 */
interface PreviousClassification {
  value: boolean
  confidence: number
  reason: string
  lastChangedAt: Date
}

/**
 * @param prisma - Prisma クライアント
 * @returns 現在 Pointer が指している generationId
 */
async function getCurrentGenerationId(prisma: PrismaClient): Promise<string | null> {
  const pointer = await prisma.readModelPointer.findUnique({ where: { modelKey: MODEL_KEY } })
  return pointer?.currentGenerationId ?? null
}

/**
 * Account を大量件数でも一括ロードせずカーソルページングで処理するため、
 * ページサイズを固定値ではなくオプション化してテストで小さい値へ差し替え可能にする。
 * ラベル値は sourceWatermarkAt 時点のものを AccountLabel から復元する。
 * lastClassificationChangedAt (true から false への解除も含む) は前世代の
 * AccountClassificationCurrent との差分から判定するが、AccountLabelChange は
 * AccountLabel 履歴上の直前値との比較だけで組み立てる。前世代の generation に依存すると、
 * ANALYZER_WORKER_CONCURRENCY > 1 で同じ前世代から並行 build した場合に、
 * 片方が見た「変更前」がもう片方の「変更後」と食い違い、変化の一部が記録されずに失われうる。
 * @param prisma - Prisma クライアント
 * @param input - 対象 generationId と検索基準時刻
 * @returns 作成した行数
 */
export async function buildAccountSummary(
  prisma: PrismaClient,
  input: BuildAccountSummaryInput,
): Promise<{ rowCount: number }> {
  const pageSize = input.pageSize ?? 2000
  let rowCount = 0
  let cursor: string | undefined

  // LabelDefinition は件数が少なく全ページで共通のため、ページごとに join せず一度だけ引く。
  const labelDefinitions = await prisma.labelDefinition.findMany({
    select: { id: true, key: true },
  })
  const labelKeyById = new Map(
    labelDefinitions.map((definition) => [definition.id, definition.key]),
  )

  const previousGenerationId = await getCurrentGenerationId(prisma)

  for (;;) {
    const accounts = await prisma.account.findMany({
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, screenName: true, displayName: true, updatedAt: true },
    })
    if (accounts.length === 0) break

    const accountIds = accounts.map((account) => account.id)

    const [
      latestLabels,
      previousLabels,
      activeFindings,
      previousClassifications,
      previousSummaries,
    ] = await Promise.all([
      findLabelsAtWatermark(prisma, accountIds, input.sourceWatermarkAt),
      findPreviousLabelsAtWatermark(prisma, accountIds, input.sourceWatermarkAt),
      findActiveFindingsAtWatermark(prisma, accountIds, input.sourceWatermarkAt),
      previousGenerationId
        ? prisma.accountClassificationCurrent.findMany({
            where: { generationId: previousGenerationId, accountId: { in: accountIds } },
            select: {
              accountId: true,
              labelDefinitionId: true,
              value: true,
              confidence: true,
              reason: true,
              lastChangedAt: true,
            },
          })
        : Promise.resolve([]),
      previousGenerationId
        ? prisma.accountSummaryCurrent.findMany({
            where: { generationId: previousGenerationId, accountId: { in: accountIds } },
            select: { accountId: true, lastClassificationChangedAt: true },
          })
        : Promise.resolve([]),
    ])

    const previousByKey = new Map<string, PreviousClassification>(
      previousClassifications.map((row) => [
        classificationKey(row.accountId, row.labelDefinitionId),
        row,
      ]),
    )
    const previousChangedAtByAccount = new Map(
      previousSummaries.map((row) => [row.accountId, row.lastClassificationChangedAt]),
    )
    const previousLabelByKey = new Map<string, LabelAtWatermark>(
      previousLabels.map((label) => [
        classificationKey(label.accountId, label.labelDefinitionId),
        label,
      ]),
    )

    const labelsByAccount = new Map<string, (typeof latestLabels)[number][]>()
    for (const label of latestLabels) {
      const list = labelsByAccount.get(label.accountId) ?? []
      list.push(label)
      labelsByAccount.set(label.accountId, list)
    }

    const findingsByAccount = new Map<string, { count: number; highestSeverity: string | null }>()
    for (const finding of activeFindings) {
      const entry = findingsByAccount.get(finding.primaryScopeId) ?? {
        count: 0,
        highestSeverity: null,
      }
      entry.count++
      entry.highestSeverity = maxSeverity(entry.highestSeverity, finding.severity)
      findingsByAccount.set(finding.primaryScopeId, entry)
    }

    const classificationRows: {
      generationId: string
      accountId: string
      labelDefinitionId: string
      value: boolean
      confidence: number
      reason: string
      lastChangedAt: Date
    }[] = []
    const changeRows: {
      accountId: string
      labelDefinitionId: string
      changeType: string
      previousValue: boolean | null
      newValue: boolean
      previousConfidence: number | null
      newConfidence: number
      previousReason: string | null
      newReason: string
      sourceId: string | null
      changedAt: Date
    }[] = []
    const summaryRows = accounts.map((account) => {
      const labels = labelsByAccount.get(account.id) ?? []
      const finding = findingsByAccount.get(account.id)
      let lastChangedAt: Date | null = previousChangedAtByAccount.get(account.id) ?? null
      const activeLabelKeys: string[] = []

      for (const label of labels) {
        const previous = previousByKey.get(classificationKey(account.id, label.labelDefinitionId))
        const changed = previous !== undefined && previous.value !== label.value
        const changedAt = changed
          ? input.sourceWatermarkAt
          : (previous?.lastChangedAt ?? label.labeledAt)

        classificationRows.push({
          generationId: input.generationId,
          accountId: account.id,
          labelDefinitionId: label.labelDefinitionId,
          value: label.value,
          confidence: label.confidence,
          reason: label.reason,
          lastChangedAt: changedAt,
        })

        // AccountLabelChange は、この build が current になるかどうかとは独立に、
        // AccountLabel 履歴上の直前値との比較だけで組み立てる (previousByKey/changed は
        // AccountClassificationCurrent の前世代スナップショットから来ており、
        // 並行 build 同士で「どちらが先に current になったか」に依存するため使わない)。
        const historyPrevious = previousLabelByKey.get(
          classificationKey(account.id, label.labelDefinitionId),
        )
        const historyChanged =
          historyPrevious !== undefined && historyPrevious.value !== label.value
        const isNewLabelInHistory = historyPrevious === undefined
        // value 自体は変わらず confidence/reason だけが変わった再判定も、
        // 判定根拠の変化として履歴に残す。value の変化と衝突しないよう、
        // historyChanged が成立するケースでは評価しない。
        const historyMetadataChanged =
          historyPrevious?.value === label.value &&
          (historyPrevious.confidence !== label.confidence ||
            historyPrevious.reason !== label.reason)

        let changeType: string | undefined
        if (historyChanged) {
          changeType = label.value ? 'added' : 'removed'
        } else if (previousGenerationId !== null && isNewLabelInHistory && label.value) {
          changeType = 'added'
        } else if (historyMetadataChanged) {
          changeType = 'updated'
        }

        if (changeType) {
          changeRows.push({
            accountId: account.id,
            labelDefinitionId: label.labelDefinitionId,
            changeType,
            previousValue: historyPrevious?.value ?? null,
            newValue: label.value,
            previousConfidence: historyPrevious?.confidence ?? null,
            newConfidence: label.confidence,
            previousReason: historyPrevious?.reason ?? null,
            newReason: label.reason,
            sourceId: input.sourceCrawlRunId ?? null,
            // 変化の原因になった AccountLabel 行自身の labeledAt を使う。
            // build の watermark ではなく変化イベント自体を一意制約のキーにすることで、
            // 並行 build が同じ変化イベントを検出しても安全に重複を弾ける。
            changedAt: label.labeledAt,
          })
        }

        if (label.value) {
          const key = labelKeyById.get(label.labelDefinitionId)
          if (key !== undefined) activeLabelKeys.push(key)
        }
        if ((label.value || changed) && (!lastChangedAt || changedAt > lastChangedAt)) {
          lastChangedAt = changedAt
        }
      }

      return {
        generationId: input.generationId,
        accountId: account.id,
        normalizedScreenName: account.screenName.toLowerCase(),
        normalizedDisplayName: account.displayName.toLowerCase(),
        searchDocument: `${account.screenName} ${account.displayName}`.toLowerCase(),
        activeLabelKeys,
        activeLabelCount: activeLabelKeys.length,
        lastClassificationChangedAt: lastChangedAt,
        lastRuleVersionChangedAt: null,
        activeFindingCount: finding?.count ?? 0,
        highestFindingSeverity: finding?.highestSeverity ?? null,
        sourceWatermarkAt: input.sourceWatermarkAt,
      }
    })

    await prisma.accountSummaryCurrent.createMany({ data: summaryRows })
    if (classificationRows.length > 0) {
      await prisma.accountClassificationCurrent.createMany({ data: classificationRows })
    }
    if (changeRows.length > 0) {
      // accountId + labelDefinitionId + changedAt の一意制約により、
      // 同じ変化イベントを複数 build (retry や ANALYZER_WORKER_CONCURRENCY > 1 の並行 build)
      // が検出しても再挿入しない。
      await prisma.accountLabelChange.createMany({ data: changeRows, skipDuplicates: true })
    }

    rowCount += accounts.length
    cursor = accounts.at(-1)?.id
    if (accounts.length < pageSize) break
  }

  return { rowCount }
}
