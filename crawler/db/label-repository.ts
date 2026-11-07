import { randomUUID } from 'node:crypto'
import { Logger } from '@book000/node-utils'
import type { Prisma, PrismaClient } from '../generated/prisma'
import type { LabelRule, LabelRuleResult } from '../labels/types'
import { compareIds } from 'id-boundary'
import { enqueueWorkItem } from './analysis-work-item-repository'

const logger = Logger.configure('label-repository')

/**
 * `LabelDefinition` を key で探し、無ければ作る。
 * upsert (INSERT ... ON CONFLICT) は衝突しても identity の採番値を 1 つ消費する。
 * id は smallint で毎周期呼ばれるため、既存行のときは INSERT を発行しない。
 */
async function ensureLabelDefinition(prisma: PrismaClient, rule: LabelRule) {
  const existing = await prisma.labelDefinition.findUnique({ where: { key: rule.key } })
  if (existing) {
    if (existing.description === rule.description && existing.retiredAt === null) return existing
    return prisma.labelDefinition.update({
      where: { id: existing.id },
      data: { description: rule.description, retiredAt: null },
    })
  }
  try {
    return await prisma.labelDefinition.create({
      data: { key: rule.key, description: rule.description },
    })
  } catch (error) {
    // 並行する別プロセスが先に作った場合は、その行を使う。
    if ((error as { code?: string }).code !== 'P2002') throw error
    return prisma.labelDefinition.findUniqueOrThrow({ where: { key: rule.key } })
  }
}

const ENSURE_RULE_VERSION_MAX_ATTEMPTS = 5

/**
 * ルール版の `versionNo` を返す。まだ無ければ次の番号を採番する。
 * @param prisma - Prisma クライアント
 * @param labelDefinitionId - 対象ラベル
 * @param ruleVersion - ルール版の文字列
 * @returns 1 始まりの versionNo
 */
export async function ensureRuleVersionNo(
  prisma: PrismaClient,
  labelDefinitionId: number,
  ruleVersion: string,
): Promise<number> {
  for (let attempt = 0; attempt < ENSURE_RULE_VERSION_MAX_ATTEMPTS; attempt += 1) {
    const existing = await prisma.labelRuleVersion.findUnique({
      where: { labelDefinitionId_ruleVersion: { labelDefinitionId, ruleVersion } },
    })
    if (existing) return existing.versionNo
    // 並行する別プロセスが同じ versionNo を採った場合は PK 衝突で何もせず、次の周回で読み直す。
    await prisma.$executeRaw`
      INSERT INTO "LabelRuleVersion" ("labelDefinitionId", "versionNo", "ruleVersion")
      SELECT ${labelDefinitionId}::smallint, COALESCE(MAX("versionNo"), 0) + 1, ${ruleVersion}
      FROM "LabelRuleVersion"
      WHERE "labelDefinitionId" = ${labelDefinitionId}::smallint
      ON CONFLICT DO NOTHING
    `
  }
  throw new Error(
    `ensureRuleVersionNo: could not allocate a versionNo (labelDefinitionId=${labelDefinitionId}, ruleVersion=${ruleVersion})`,
  )
}

/**
 * 全ルールの `LabelDefinition` と現行の `LabelRuleVersion` を保証する。
 * `LabelDefinition.id` は再利用せず、渡されなかった既存ラベルは行を消さずに `retiredAt` を設定する。
 * `versionNo` は 1 始まりで、ルールの `version` が初めて現れたときに次の値を割り当てる。
 * `rules` には有効な全ルールを渡すこと。一部だけ渡すと残りが廃止扱いになる。
 * @param prisma - Prisma クライアント
 * @param rules - 有効な全ルール
 * @returns 各ルールの key からその `LabelDefinition` id へのマップ
 */
export async function ensureLabelDefinitionsForRules(
  prisma: PrismaClient,
  rules: LabelRule[],
): Promise<Map<string, number>> {
  const entries: (readonly [string, number])[] = []
  // versionNo の採番が同一ラベル内で競合しないよう、ルールは 1 件ずつ処理する。
  for (const rule of rules) {
    const definition = await ensureLabelDefinition(prisma, rule)
    const versionNo = await ensureRuleVersionNo(prisma, definition.id, rule.version)
    if (definition.currentRuleVersionNo !== versionNo) {
      await prisma.labelDefinition.update({
        where: { id: definition.id },
        data: { currentRuleVersionNo: versionNo },
      })
    }
    entries.push([rule.key, definition.id])
  }
  // ルールが 1 件も渡されないときに全ラベルを廃止してしまわないよう、廃止は渡されたルールがあるときだけ行う。
  if (rules.length > 0) {
    await prisma.labelDefinition.updateMany({
      where: { retiredAt: null, key: { notIn: rules.map((rule) => rule.key) } },
      data: { retiredAt: new Date() },
    })
  }
  return new Map(entries)
}

/**
 * `AccountClassificationObservation.classificationSnapshot` に格納する 1 ラベル分の内容。
 * analyzer 側の分岐ロジックが対応バージョンを判定するため、
 * `snapshotVersion` とセットで保存する。
 */
export interface ClassificationSnapshotEntry {
  labelDefinitionId: number
  value: boolean
  confidence: number
  reason: string
  method: string
  ruleVersion: string
  evaluable: boolean
  labeledAt: string
}

/** `AccountClassificationObservation.snapshotVersion` の現行値。 */
export const ACCOUNT_CLASSIFICATION_SNAPSHOT_VERSION = 1

/** 書き込み元の種別。`AccountActiveLabel.sourceKind` の 0 (legacy) は移行でのみ入る。 */
export type AccountLabelSourceKind = 'crawl' | 'relabel'

const SOURCE_KIND_CODE: Record<AccountLabelSourceKind, number> = { crawl: 1, relabel: 2 }

/** 評価の結果。`set_label_result` の p_outcomes と同じ値。 */
const OUTCOME_TRUE = 1
const OUTCOME_FALSE = 0
const OUTCOME_UNEVALUABLE = -1

/** CAS の不一致 (別の書き込みが先に入った) を受けて、書き込みを試行する回数の上限。 */
export const LABEL_WRITE_MAX_ATTEMPTS = 3

export interface AccountLabelBulkInput {
  accountId: string
  labelDefinitionId: number
  result: LabelRuleResult
  method: string
  ruleVersion: string
}

/** 複数 row の writer 間で lock 順序を共有するための正準順序。 */
function orderAccountLabelBulkInputs(labels: AccountLabelBulkInput[]): AccountLabelBulkInput[] {
  return labels.toSorted(
    (left, right) =>
      compareIds(left.accountId, right.accountId) ||
      left.labelDefinitionId - right.labelDefinitionId,
  )
}

/**
 * 評価入力を読む前の `AccountLabelState.rev` を取得する。状態行がまだ無いアカウントは 0。
 * 評価入力 (Account・Tweet など) を読む「前」に呼ぶこと。後に呼ぶと、入力を読んだ後に入った書き込みを検知できない。
 * @param prisma - Prisma クライアント
 * @param accountIds - 対象アカウント
 * @returns accountId から rev へのマップ。全 accountId を含む
 */
export async function loadAccountLabelRevs(
  prisma: PrismaClient | Prisma.TransactionClient,
  accountIds: string[],
): Promise<Map<string, number>> {
  const revs = new Map<string, number>(accountIds.map((accountId) => [accountId, 0]))
  if (accountIds.length === 0) return revs
  const rows = await prisma.accountLabelState.findMany({
    where: { accountId: { in: accountIds } },
    select: { accountId: true, rev: true },
  })
  for (const row of rows) revs.set(row.accountId, row.rev)
  return revs
}

/** 評価入力を読む前に取得した、1 アカウント分のラベル状態。 */
export interface AccountLabelSnapshot {
  rev: number
  /** `AccountLabelState.versions` と同じ符号付きの版 (添字は LabelDefinition.id - 1)。 */
  versions: number[]
  /** true のラベルの現在値。キーは labelDefinitionId。 */
  active: Map<number, { ruleVersionNo: number; confidence: number; reason: string; method: string }>
}

/**
 * 評価入力を読む前のラベル状態を取得する。状態行がまだ無いアカウントは rev 0・空の状態。
 * 同じ rev のまま書き込みに成功する限り、ここで読んだ状態は現在の状態と一致する。
 * @param prisma - Prisma クライアント
 * @param accountIds - 対象アカウント
 * @returns accountId から状態へのマップ。全 accountId を含む
 */
export async function loadAccountLabelStates(
  prisma: PrismaClient | Prisma.TransactionClient,
  accountIds: string[],
): Promise<Map<string, AccountLabelSnapshot>> {
  const snapshots = new Map<string, AccountLabelSnapshot>(
    accountIds.map((accountId) => [accountId, { rev: 0, versions: [], active: new Map() }]),
  )
  if (accountIds.length === 0) return snapshots
  // 状態 (rev) を先に読む。活性ラベルをその後に読めば、読み違えが起きても rev が古い側に倒れ、
  // CAS の失敗と再試行で正しく直る。逆順や並列では、新しい rev と古い活性ラベルの組になり得る。
  const states = await prisma.accountLabelState.findMany({
    where: { accountId: { in: accountIds } },
    select: { accountId: true, rev: true, versions: true },
  })
  const activeRows = await prisma.accountActiveLabel.findMany({
      where: { accountId: { in: accountIds } },
      select: {
        accountId: true,
        labelDefinitionId: true,
        ruleVersionNo: true,
        confidence: true,
        reason: true,
        method: true,
      },
  })
  for (const state of states) {
    const snapshot = snapshots.get(state.accountId)
    if (snapshot) {
      snapshot.rev = state.rev
      snapshot.versions = state.versions
    }
  }
  for (const row of activeRows) {
    snapshots.get(row.accountId)?.active.set(row.labelDefinitionId, row)
  }
  return snapshots
}

export interface RecordAccountLabelsBulkForAccountsParams {
  /** 記録対象の評価結果一覧。各行が自分自身の `accountId` を持つ。1 アカウントの行は全ラベル分そろえること。 */
  labels: AccountLabelBulkInput[]
  /** 評価入力を読んだ時点の rev。`labels` に含まれる全アカウントを持つこと。 */
  expectedRevByAccountId: ReadonlyMap<string, number>
  /**
   * 同じ rev で読んだ状態。指定すると、状態と同じ結果の行は書き込みから除き、全行が同じアカウントは何も書かない。
   * rev が一致する限り状態は変わっていないため、除いても結果は変わらない。
   */
  baselineByAccountId?: ReadonlyMap<string, AccountLabelSnapshot>
  /** どの処理がこの行を書いたか (crawl・relabel)。 */
  sourceKind: AccountLabelSourceKind
  /** 発生源となった run の ID。 */
  sourceId?: string
  /** 発生源となったログインアカウント。 */
  sourceUsername?: string
}

/**
 * `recordAccountLabelsBulkForAccounts` が SQL 呼び出しを分割する行数。
 * この値を超えて 1 回の `$queryRaw` にまとめると、Postgres の推定コストが `jit_above_cost` を超えて JIT コンパイルが走り、実行時間より長いコンパイル時間がかかる。
 */
const RECORD_ACCOUNT_LABELS_BULK_SUB_CHUNK_SIZE = 2000

function toOutcome(result: LabelRuleResult): number {
  if (result.evaluable === false) return OUTCOME_UNEVALUABLE
  return result.value ? OUTCOME_TRUE : OUTCOME_FALSE
}

const RULE_VERSION_KEY_SEPARATOR = '\u0000'

function ruleVersionKey(labelDefinitionId: number, ruleVersion: string): string {
  return `${labelDefinitionId}${RULE_VERSION_KEY_SEPARATOR}${ruleVersion}`
}

/**
 * ルールの `version` 文字列を `LabelRuleVersion.versionNo` へ変換する。
 * @throws `ensureLabelDefinitionsForRules` を通っていない (versionNo 未採番の) ルール版が含まれる場合
 */
async function resolveRuleVersionNos(
  prisma: PrismaClient | Prisma.TransactionClient,
  rules: { labelDefinitionId: number; ruleVersion: string }[],
): Promise<Map<string, number>> {
  const rows = await prisma.labelRuleVersion.findMany({
    where: {
      labelDefinitionId: { in: [...new Set(rules.map((rule) => rule.labelDefinitionId))] },
      ruleVersion: { in: [...new Set(rules.map((rule) => rule.ruleVersion))] },
    },
  })
  const versionNos = new Map(
    rows.map((row) => [ruleVersionKey(row.labelDefinitionId, row.ruleVersion), row.versionNo]),
  )
  for (const rule of rules) {
    if (!versionNos.has(ruleVersionKey(rule.labelDefinitionId, rule.ruleVersion))) {
      throw new Error(
        `LabelRuleVersion not found (labelDefinitionId=${rule.labelDefinitionId}, ruleVersion=${rule.ruleVersion}); call ensureLabelDefinitionsForRules first`,
      )
    }
  }
  return versionNos
}

/** 1 アカウントの行が途中で分割されないよう、アカウント境界で行数の上限ごとに区切る。 */
function chunkByAccount(
  labels: AccountLabelBulkInput[],
  maxRows: number,
): AccountLabelBulkInput[][] {
  const chunks: AccountLabelBulkInput[][] = []
  let current: AccountLabelBulkInput[] = []
  let index = 0
  while (index < labels.length) {
    const accountId = labels[index].accountId
    let end = index
    while (end < labels.length && labels[end].accountId === accountId) end += 1
    const accountRows = labels.slice(index, end)
    if (current.length > 0 && current.length + accountRows.length > maxRows) {
      chunks.push(current)
      current = []
    }
    current.push(...accountRows)
    index = end
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * 状態と同じ結果の行を除く。
 * 評価済みの版が同じで、true の行は confidence・reason・method・版も同じ行が対象。
 */
function dropUnchangedLabels(
  labels: AccountLabelBulkInput[],
  versionNos: ReadonlyMap<string, number>,
  baselineByAccountId: ReadonlyMap<string, AccountLabelSnapshot>,
): AccountLabelBulkInput[] {
  return labels.filter((label) => {
    const baseline = baselineByAccountId.get(label.accountId)
    if (!baseline) return true
    const outcome = toOutcome(label.result)
    const versionNo = versionNos.get(ruleVersionKey(label.labelDefinitionId, label.ruleVersion))
    const slot = baseline.versions[label.labelDefinitionId - 1] ?? 0
    const expectedSlot = outcome === OUTCOME_UNEVALUABLE ? -(versionNo ?? 0) : (versionNo ?? 0)
    if (slot !== expectedSlot) return true
    if (outcome !== OUTCOME_TRUE) return baseline.active.has(label.labelDefinitionId)
    const current = baseline.active.get(label.labelDefinitionId)
    return (
      current?.confidence !== label.result.confidence ||
      current.reason !== label.result.reason ||
      current.method !== label.method
    )
  })
}

/**
 * 複数アカウント分の評価結果を `set_label_result` で記録する。
 * アカウントごとの CAS (評価入力を読んだ時点の rev との比較) に失敗したアカウントは書かれず、戻り値で返る。
 * 呼び出し側は入力を読み直して再評価し、{@link LABEL_WRITE_MAX_ATTEMPTS} を上限に再試行する。
 * 評価不能 (`evaluable === false`) は value に関わらず評価不能として記録する。
 * @param prisma - Prisma クライアント (READ COMMITTED の transaction client も可)
 * @param params - 記録対象の評価結果と、評価入力を読んだ時点の rev
 * @returns CAS に失敗して書かれなかったアカウントの ID
 */
export async function recordAccountLabelsBulkForAccounts(
  prisma: PrismaClient | Prisma.TransactionClient,
  params: RecordAccountLabelsBulkForAccountsParams,
): Promise<string[]> {
  const allLabels = orderAccountLabelBulkInputs(params.labels)
  if (allLabels.length === 0) return []
  const versionNos = await resolveRuleVersionNos(prisma, allLabels)
  const orderedLabels = params.baselineByAccountId
    ? dropUnchangedLabels(allLabels, versionNos, params.baselineByAccountId)
    : allLabels
  const missed: string[] = []
  const { sourceKind, sourceId, sourceUsername } = params

  for (const subChunk of chunkByAccount(orderedLabels, RECORD_ACCOUNT_LABELS_BULK_SUB_CHUNK_SIZE)) {
    const outcomes = subChunk.map((label) => toOutcome(label.result))
    const expectedRevs = subChunk.map((label) => {
      const rev = params.expectedRevByAccountId.get(label.accountId)
      if (rev === undefined) {
        throw new Error(`expected rev is missing (accountId=${label.accountId})`)
      }
      return rev
    })
    const versionNoValues = subChunk.map((label) =>
      versionNos.get(ruleVersionKey(label.labelDefinitionId, label.ruleVersion)),
    )
    const confidences = subChunk.map((label, i) =>
      outcomes[i] === OUTCOME_TRUE ? label.result.confidence : null,
    )
    const reasons = subChunk.map((label, i) =>
      outcomes[i] === OUTCOME_TRUE ? label.result.reason : null,
    )
    const methods = subChunk.map((label, i) => (outcomes[i] === OUTCOME_TRUE ? label.method : null))
    const rows = await prisma.$queryRaw<{ missed: string[] }[]>`
      SELECT set_label_result(
        ${subChunk.map((label) => label.accountId)}::bigint[],
        ${subChunk.map((label) => label.labelDefinitionId)}::smallint[],
        ${expectedRevs}::integer[],
        ${outcomes}::smallint[],
        ${versionNoValues}::smallint[],
        ${confidences}::double precision[],
        ${reasons}::text[],
        ${methods}::text[],
        now(),
        ${SOURCE_KIND_CODE[sourceKind]}::smallint,
        ${sourceId ?? null}::text,
        ${sourceUsername ?? null}::text
      )::text[] AS "missed"
    `
    missed.push(...(rows[0]?.missed ?? []))
  }
  return missed
}

/** recordCrawlAccountLabelsAtomic の入力。1 author 分のルール結果一覧を含む。 */
export interface RecordCrawlAccountLabelsAtomicParams {
  /** ルール適用対象の Account ID。 */
  accountId: string
  /** 呼び出し元の CrawlRun ID。 */
  crawlRunId: string
  /** 処理中のログインアカウントの username。 */
  username: string
  /** author 1 件分のルール適用結果一覧。 */
  labels: {
    labelDefinitionId: number
    result: LabelRuleResult
    method: string
    ruleVersion: string
  }[]
}

/** `CrawlAccountLabelRun` への claim に成功した 1 ルール分の結果。 */
interface ClaimedLabelRow {
  labelDefinitionId: number
  method: string
  ruleVersion: string
  result: LabelRuleResult
}

/**
 * 永続化された状態 (`AccountLabelState` と `AccountActiveLabel`) から、observation 用の snapshot を合成する。
 * true の行は `AccountActiveLabel` から復元する。
 * false と評価不能の行は reason と confidence を持たないため、今回の評価結果が状態と一致していればそれを使い、
 * 一致しない (書き込みが競合で見送られた) ときは中立値にする。
 * @throws 状態の添字が 0 (未評価) のラベルがある場合
 */
async function synthesizeClassificationSnapshot(
  prisma: PrismaClient,
  accountId: string,
  labels: RecordCrawlAccountLabelsAtomicParams['labels'],
): Promise<ClassificationSnapshotEntry[]> {
  const labelDefinitionIds = [...new Set(labels.map((label) => label.labelDefinitionId))].toSorted(
    (left, right) => left - right,
  )
  const state = await prisma.accountLabelState.findUnique({ where: { accountId } })
  const [activeRows, ruleVersions] = await Promise.all([
    prisma.accountActiveLabel.findMany({
      where: { accountId, labelDefinitionId: { in: labelDefinitionIds } },
    }),
    prisma.labelRuleVersion.findMany({ where: { labelDefinitionId: { in: labelDefinitionIds } } }),
  ])
  const activeByLabel = new Map(activeRows.map((row) => [row.labelDefinitionId, row] as const))
  const ruleVersionByKey = new Map(
    ruleVersions.map((row) => [`${row.labelDefinitionId}:${row.versionNo}`, row.ruleVersion]),
  )
  const inputByLabel = new Map(labels.map((label) => [label.labelDefinitionId, label] as const))

  return labelDefinitionIds.map((labelDefinitionId) => {
    // versions の添字は LabelDefinition.id (1 始まり) で、配列は 0 始まりのため 1 を引く。
    const slot = state?.versions[labelDefinitionId - 1] ?? 0
    if (slot === 0) {
      throw new Error(
        `recordCrawlAccountLabelsAtomicWithinTx: label slot is 0 after persistence (accountId=${accountId}, labelDefinitionId=${labelDefinitionId})`,
      )
    }
    const ruleVersion = ruleVersionByKey.get(`${labelDefinitionId}:${Math.abs(slot)}`)
    if (ruleVersion === undefined) {
      throw new Error(
        `recordCrawlAccountLabelsAtomicWithinTx: LabelRuleVersion not found (labelDefinitionId=${labelDefinitionId}, versionNo=${Math.abs(slot)})`,
      )
    }
    const active = slot > 0 ? activeByLabel.get(labelDefinitionId) : undefined
    if (active) {
      return {
        labelDefinitionId,
        value: true,
        confidence: active.confidence,
        reason: active.reason,
        method: active.method,
        ruleVersion,
        evaluable: true,
        labeledAt: active.labeledAt.toISOString(),
      }
    }
    const input = inputByLabel.get(labelDefinitionId)
    const evaluable = slot > 0
    const inputAgrees =
      input !== undefined && !input.result.value && (input.result.evaluable ?? true) === evaluable
    return {
      labelDefinitionId,
      value: false,
      confidence: inputAgrees ? input.result.confidence : 0.5,
      reason: inputAgrees ? input.result.reason : '',
      method: input?.method ?? '',
      ruleVersion,
      evaluable,
      labeledAt: (state?.evaluatedAt ?? new Date()).toISOString(),
    }
  })
}

/**
 * 1 author 分のルール結果をまとめて atomic に永続化する。
 * `CrawlAccountLabelRun` の claim をまとめて INSERT し、成功した行だけ
 * `set_label_result` で書き込んでから、claim が 1 件でも
 * 成功していれば `AccountClassificationObservation` を 1 行作成する。
 * 全 claim が空振り (再開時の重複呼び出し) の場合は observation を作らず null を返す。
 * 自前で transaction を開始しないため、呼び出し元が `tx as unknown as PrismaClient` を渡せば、
 * 外側の transaction に合成できる。
 * @param prisma - Prisma クライアント (または transaction client)
 * @param params - 対象アカウントと author 分のルール結果一覧
 * @returns 作成した `AccountClassificationObservation` の id。全 claim 空振りなら null
 */
export async function recordCrawlAccountLabelsAtomicWithinTx(
  prisma: PrismaClient,
  params: RecordCrawlAccountLabelsAtomicParams,
): Promise<string | null> {
  if (params.labels.length === 0) return null

  const claimIds = params.labels.map(() => randomUUID())
  const labelDefinitionIds = params.labels.map((label) => label.labelDefinitionId)
  const methods = params.labels.map((label) => label.method)
  const ruleVersions = params.labels.map((label) => label.ruleVersion)

  const claimedRows = await prisma.$queryRaw<
    { labelDefinitionId: number; method: string; ruleVersion: string }[]
  >`
    INSERT INTO "CrawlAccountLabelRun"
      ("id", "crawlRunId", "username", "accountId", "labelDefinitionId", "method", "ruleVersion")
    SELECT * FROM UNNEST(
      ${claimIds}::text[],
      ARRAY(SELECT ${params.crawlRunId} FROM generate_series(1, ${params.labels.length})),
      ARRAY(SELECT ${params.username} FROM generate_series(1, ${params.labels.length})),
      ARRAY(SELECT ${params.accountId}::bigint FROM generate_series(1, ${params.labels.length})),
      ${labelDefinitionIds}::smallint[],
      ${methods}::text[],
      ${ruleVersions}::text[]
    ) AS u("id", "crawlRunId", "username", "accountId", "labelDefinitionId", "method", "ruleVersion")
    ON CONFLICT ("crawlRunId", "username", "accountId", "labelDefinitionId", "method", "ruleVersion") DO NOTHING
    RETURNING "labelDefinitionId", "method", "ruleVersion"
  `
  if (claimedRows.length === 0) return null

  const claimedKeys = new Set(
    claimedRows.map((row) => `${row.labelDefinitionId} ${row.method} ${row.ruleVersion}`),
  )
  const claimedLabels: ClaimedLabelRow[] = params.labels
    .filter((label) =>
      claimedKeys.has(`${label.labelDefinitionId} ${label.method} ${label.ruleVersion}`),
    )
    .map((label) => ({
      labelDefinitionId: label.labelDefinitionId,
      method: label.method,
      ruleVersion: label.ruleVersion,
      result: label.result,
    }))

  // この評価入力 (Account と Tweet) は、呼び出し元が同じ transaction 内で書いたばかりの行から作られ、
  // その行ロックを commit まで保持している。同じアカウントに先に commit した並行 writer の入力は、
  // この transaction の変更を見ていないため、今回の評価のほうが常に新しい。
  // CAS に負けたときは評価をやり直さず、rev だけを読み直して書き直す。
  let written = false
  for (let attempt = 0; attempt < LABEL_WRITE_MAX_ATTEMPTS && !written; attempt += 1) {
    const expectedRevByAccountId = await loadAccountLabelRevs(prisma, [params.accountId])
    const missed = await recordAccountLabelsBulkForAccounts(prisma, {
      labels: claimedLabels.map((label) => ({ ...label, accountId: params.accountId })),
      expectedRevByAccountId,
      sourceKind: 'crawl',
      sourceId: params.crawlRunId,
      sourceUsername: params.username,
    })
    written = missed.length === 0
  }
  if (!written) {
    logger.warn(
      `recordCrawlAccountLabelsAtomicWithinTx: label write was skipped after ${LABEL_WRITE_MAX_ATTEMPTS} CAS misses (accountId=${params.accountId})`,
    )
  }

  // Observation の snapshot は、入力値ではなく永続化済みの状態を唯一の source of truth とする。
  // 書き込みが見送られたときに入力値を残すと、DB は別 writer の新しい値なのに Observation だけが古い値になる。
  const classificationSnapshot = await synthesizeClassificationSnapshot(
    prisma,
    params.accountId,
    params.labels,
  )

  const observation = await prisma.accountClassificationObservation.create({
    data: {
      accountId: params.accountId,
      crawlRunId: params.crawlRunId,
      username: params.username,
      observedAt: new Date(),
      labelCount: claimedLabels.length,
      snapshotVersion: ACCOUNT_CLASSIFICATION_SNAPSHOT_VERSION,
      classificationSnapshot: classificationSnapshot as unknown as Prisma.InputJsonValue,
    },
  })

  // Observation の commit と WorkItem の enqueue が別トランザクションだと、
  // 片方だけ成功する状態 (refresh が永久に走らない、または存在しない
  // Observation を指す WorkItem) が生まれる。同一トランザクション内で
  // enqueue することで、Observation が確定した時点で refresh も必ず予約される。
  await enqueueWorkItem(prisma, {
    kind: 'account_summary_refresh',
    triggerType: 'account_classification_observation',
    triggerId: observation.id,
  })

  return observation.id
}

/**
 * {@link recordCrawlAccountLabelsAtomicWithinTx} を自前の transaction でラップする薄い wrapper。
 * @param prisma - Prisma クライアント
 * @param params - 対象アカウントと author 分のルール結果一覧
 * @returns 作成した `AccountClassificationObservation` の id。全 claim 空振りなら null
 */
export async function recordCrawlAccountLabelsAtomic(
  prisma: PrismaClient,
  params: RecordCrawlAccountLabelsAtomicParams,
): Promise<string | null> {
  return prisma.$transaction(
    (tx) => recordCrawlAccountLabelsAtomicWithinTx(tx as unknown as PrismaClient, params),
    { maxWait: 15_000, timeout: 15_000 },
  )
}

/**
 * 一度も評価されたことのない account への account_relabel enqueue を避けるための存在確認。
 * @param prisma - Prisma クライアント
 * @param accountIds - 存在確認する accountId の一覧
 * @returns `AccountLabelState` に行がある (一度でも評価された) accountId の集合
 */
export async function filterAccountIdsWithExistingLabels(
  prisma: PrismaClient,
  accountIds: string[],
): Promise<Set<string>> {
  if (accountIds.length === 0) return new Set()
  const rows = await prisma.accountLabelState.findMany({
    where: { accountId: { in: accountIds } },
    select: { accountId: true },
  })
  return new Set(rows.map((row) => row.accountId))
}

/**
 * 現行版で評価済みでないラベルを 1 つ以上持つアカウントを返す。
 * 現行版で評価済みとは、`AccountLabelState.versions` の該当添字の絶対値が versionNo と等しいこと。
 * 評価不能は負の値だが、現行版で評価不能と確定していれば評価済みとして扱う。
 * 状態行がないアカウントと、添字が 0 または配列外のラベルを持つアカウントは未評価として返す。
 * @param prisma - Prisma クライアント
 * @param accountIds - 判定対象のアカウント
 * @param rules - 現行の (labelDefinitionId, ruleVersion) 一覧
 * @returns 少なくとも 1 つのラベルが現行版で評価済みでないアカウントの ID
 */
export async function findAccountIdsWithStaleLabels(
  prisma: PrismaClient,
  accountIds: string[],
  rules: { labelDefinitionId: number; ruleVersion: string }[],
): Promise<string[]> {
  if (accountIds.length === 0 || rules.length === 0) return []
  const versionNos = await resolveRuleVersionNos(prisma, rules)
  const labelIds = rules.map((rule) => rule.labelDefinitionId)
  const currentVersionNos = rules.map((rule) =>
    versionNos.get(ruleVersionKey(rule.labelDefinitionId, rule.ruleVersion)),
  )
  const rows = await prisma.$queryRaw<{ accountId: string }[]>`
    SELECT a."id"::text AS "accountId"
    FROM unnest(${accountIds}::bigint[]) AS a("id")
    LEFT JOIN "AccountLabelState" AS s ON s."accountId" = a."id"
    WHERE EXISTS (
      SELECT 1
      FROM unnest(${labelIds}::smallint[], ${currentVersionNos}::smallint[]) AS r("labelId", "versionNo")
      WHERE abs(COALESCE(s."versions"[r."labelId"], 0)) IS DISTINCT FROM r."versionNo"
    )
  `
  return rows.map((row) => row.accountId)
}
