import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../db/client'
import { buildAccountSummary } from './build-account-summary'

describe.skipIf(!process.env.DATABASE_URL)('buildAccountSummary', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    // 前回実行分の pointer/state が残ったままだと、previousGenerationId の判定が
    // 「まだ何も公開されていない」前提のテストと食い違い、意図しない changeRow の有無が生じる。
    await prisma.readModelPointer.deleteMany({ where: { modelKey: 'account_summary' } })
    await prisma.readModelState.deleteMany({ where: { modelKey: 'account_summary' } })
    await prisma.accountLabelChange.deleteMany()
    await prisma.accountClassificationCurrent.deleteMany()
    await prisma.accountSummaryCurrent.deleteMany()
    await prisma.findingEvidence.deleteMany()
    await prisma.reviewFindingOccurrence.deleteMany()
    await prisma.reviewFinding.deleteMany()
    await prisma.accountLabel.deleteMany()
    await prisma.accountLabelLatest.deleteMany()
    await prisma.blockStateChange.deleteMany()
    await prisma.block.deleteMany()
    await prisma.account.deleteMany()
  })

  // 他のテストファイルは AccountLabel/AccountLabelLatest を消さずに Account/LabelDefinition を消すため、
  // このファイルで作った紐づけを残すと相手側の後始末が外部キーで失敗する。
  afterAll(async () => {
    await prisma.accountLabelChange.deleteMany()
    await prisma.accountClassificationCurrent.deleteMany()
    await prisma.accountSummaryCurrent.deleteMany()
    await prisma.accountLabel.deleteMany()
    await prisma.accountLabelLatest.deleteMany()
    await prisma.account.deleteMany()
  })

  /**
   * buildAccountSummary は AccountLabelLatest ではなく AccountLabel の履歴から
   * sourceWatermarkAt 時点の値を復元するため、テストのラベル付けはこちらへ作成する。
   * @param params - 作成するラベル履歴行のパラメータ
   * @returns 作成した AccountLabel の id
   */
  async function createAccountLabel(params: {
    accountId: string
    labelDefinitionId: string
    value: boolean
    confidence: number
    reason: string
    labeledAt: Date
  }): Promise<string> {
    const row = await prisma.accountLabel.create({
      data: {
        accountId: params.accountId,
        labelDefinitionId: params.labelDefinitionId,
        value: params.value,
        confidence: params.confidence,
        reason: params.reason,
        method: 'rule',
        ruleVersion: 'v1',
        labeledAt: params.labeledAt,
      },
    })
    return row.id
  }

  /**
   * @param screenName - 作成する Account の screenName
   * @returns 作成した Account の ID
   */
  async function createAccount(screenName: string): Promise<string> {
    const accountId = `account-${randomUUID()}`
    await prisma.account.create({
      data: {
        id: accountId,
        screenName,
        displayName: screenName,
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    return accountId
  }

  it('ページサイズを超える件数の Account でも全件が新 generationId で作られる', async () => {
    const accounts = await Promise.all(
      Array.from({ length: 5 }, async (_, index) =>
        prisma.account.create({
          data: {
            id: `account-${randomUUID()}`,
            screenName: `alice_${index}`,
            displayName: `Alice ${index}`,
            followersCount: 0,
            followingCount: 0,
            tweetCount: 0,
            accountCreatedAt: new Date(),
          },
        }),
      ),
    )

    const generationId = `generation-${randomUUID()}`
    const result = await buildAccountSummary(prisma, {
      generationId,
      sourceWatermarkAt: new Date(),
      pageSize: 2,
    })

    expect(result.rowCount).toBe(5)

    const rows = await prisma.accountSummaryCurrent.findMany({ where: { generationId } })
    expect(rows).toHaveLength(5)
    expect(rows.map((row) => row.accountId).toSorted()).toEqual(
      accounts.map((account) => account.id).toSorted(),
    )
  })

  it('activeLabelKeys には LabelDefinition の key が入る', async () => {
    const accountId = `account-${randomUUID()}`
    await prisma.account.create({
      data: {
        id: accountId,
        screenName: 'bob',
        displayName: 'Bob',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    const labelKey = `spam_${randomUUID().slice(0, 8)}`
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: labelKey, description: 'テスト用ラベル' },
    })
    await createAccountLabel({
      accountId,
      labelDefinitionId: labelDefinition.id,
      value: true,
      confidence: 1,
      reason: 'test',
      labeledAt: new Date(),
    })

    const generationId = `generation-${randomUUID()}`
    await buildAccountSummary(prisma, { generationId, sourceWatermarkAt: new Date() })

    const row = await prisma.accountSummaryCurrent.findFirstOrThrow({
      where: { generationId, accountId },
    })
    expect(row.activeLabelKeys).toEqual([labelKey])
    expect(row.activeLabelCount).toBe(1)
  })

  it('AccountLabelLatest の全ラベルを AccountClassificationCurrent に書き出す', async () => {
    const accountId = await createAccount('carol')
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `bot_${randomUUID().slice(0, 8)}`, description: 'テスト用ラベル' },
    })
    await createAccountLabel({
      accountId,
      labelDefinitionId: labelDefinition.id,
      value: false,
      confidence: 0.4,
      reason: 'no match',
      labeledAt: new Date(),
    })

    const generationId = `generation-${randomUUID()}`
    await buildAccountSummary(prisma, { generationId, sourceWatermarkAt: new Date() })

    const rows = await prisma.accountClassificationCurrent.findMany({
      where: { generationId, accountId },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.value).toBe(false)
    expect(rows[0]?.reason).toBe('no match')
  })

  it('ラベル解除を AccountLabelChange に記録し lastClassificationChangedAt に反映する', async () => {
    const accountId = await createAccount('dave')
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `spam_${randomUUID().slice(0, 8)}`, description: 'テスト用ラベル' },
    })
    const labeledAt = new Date(Date.now() - 60 * 60 * 1000)
    await createAccountLabel({
      accountId,
      labelDefinitionId: labelDefinition.id,
      value: true,
      confidence: 0.9,
      reason: 'matched',
      labeledAt,
    })

    const firstGenerationId = `generation-${randomUUID()}`
    await buildAccountSummary(prisma, {
      generationId: firstGenerationId,
      sourceWatermarkAt: labeledAt,
    })
    await prisma.readModelPointer.upsert({
      where: { modelKey: 'account_summary' },
      create: { modelKey: 'account_summary', currentGenerationId: firstGenerationId },
      update: { currentGenerationId: firstGenerationId },
    })

    const removedAt = new Date()
    await createAccountLabel({
      accountId,
      labelDefinitionId: labelDefinition.id,
      value: false,
      confidence: 0.9,
      reason: 'no longer matched',
      labeledAt: removedAt,
    })
    const secondGenerationId = `generation-${randomUUID()}`
    await buildAccountSummary(prisma, {
      generationId: secondGenerationId,
      sourceWatermarkAt: removedAt,
    })

    const changes = await prisma.accountLabelChange.findMany({ where: { accountId } })
    expect(changes).toHaveLength(1)
    expect(changes[0]?.changeType).toBe('removed')
    expect(changes[0]?.previousValue).toBe(true)
    expect(changes[0]?.newValue).toBe(false)

    const summary = await prisma.accountSummaryCurrent.findFirstOrThrow({
      where: { generationId: secondGenerationId, accountId },
    })
    expect(summary.activeLabelKeys).toEqual([])
    expect(summary.lastClassificationChangedAt?.getTime()).toBe(removedAt.getTime())
  })

  it('sourceWatermarkAt より後に付いたラベルは backlog 処理中の generation に混ぜない', async () => {
    const accountId = await createAccount('erin')
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `spam_${randomUUID().slice(0, 8)}`, description: 'テスト用ラベル' },
    })
    const watermarkAt = new Date(Date.now() - 60 * 60 * 1000)
    await createAccountLabel({
      accountId,
      labelDefinitionId: labelDefinition.id,
      value: false,
      confidence: 0.3,
      reason: 'no match',
      labeledAt: new Date(watermarkAt.getTime() - 60 * 60 * 1000),
    })
    // watermark より後に付いた値。backlog 処理中の古い generation には反映されないはず。
    await createAccountLabel({
      accountId,
      labelDefinitionId: labelDefinition.id,
      value: true,
      confidence: 0.9,
      reason: 'matched after watermark',
      labeledAt: new Date(watermarkAt.getTime() + 60 * 1000),
    })

    const generationId = `generation-${randomUUID()}`
    await buildAccountSummary(prisma, { generationId, sourceWatermarkAt: watermarkAt })

    const summary = await prisma.accountSummaryCurrent.findFirstOrThrow({
      where: { generationId, accountId },
    })
    expect(summary.activeLabelKeys).toEqual([])

    const classification = await prisma.accountClassificationCurrent.findFirstOrThrow({
      where: { generationId, accountId, labelDefinitionId: labelDefinition.id },
    })
    expect(classification.value).toBe(false)
    expect(classification.reason).toBe('no match')
  })

  it('activeFindingCount/highestFindingSeverity は現在値ではなく sourceWatermarkAt 時点の Occurrence 履歴から復元する', async () => {
    const accountId = await createAccount('grace')
    const firstDetectedAt = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const watermarkAt = new Date(Date.now() - 60 * 60 * 1000)

    const finding = await prisma.reviewFinding.create({
      data: {
        fingerprint: `fingerprint-${randomUUID()}`,
        identityVersion: 1,
        type: 'label_count_drop',
        primaryScopeType: 'account',
        primaryScopeId: accountId,
        // 現在は resolved だが、watermark 時点ではまだ active だったケースを想定する。
        status: 'resolved',
        currentSeverity: 'high',
        maximumSeverity: 'high',
        firstDetectedAt,
      },
    })
    await prisma.reviewFindingOccurrence.create({
      data: {
        findingId: finding.id,
        observedAt: firstDetectedAt,
        stateTransition: 'active',
        severity: 'high',
        sourceType: 'label_metric',
        sourceId: 'crawl-1',
        policyHash: 'policy-1',
        detectorVersion: 'v1',
        observationKey: 'crawl-1',
      },
    })
    // watermark より後に resolved した occurrence。backlog 処理中の古い generation には
    // 反映されず、watermark 時点ではまだ active だったとみなすべき。
    await prisma.reviewFindingOccurrence.create({
      data: {
        findingId: finding.id,
        observedAt: new Date(watermarkAt.getTime() + 60 * 1000),
        stateTransition: 'resolved',
        severity: 'high',
        sourceType: 'label_metric',
        sourceId: 'crawl-2',
        policyHash: 'policy-1',
        detectorVersion: 'v1',
        observationKey: 'crawl-2',
      },
    })

    const generationId = `generation-${randomUUID()}`
    await buildAccountSummary(prisma, { generationId, sourceWatermarkAt: watermarkAt })

    const summary = await prisma.accountSummaryCurrent.findFirstOrThrow({
      where: { generationId, accountId },
    })
    expect(summary.activeFindingCount).toBe(1)
    expect(summary.highestFindingSeverity).toBe('high')
  })

  it('同じ CrawlRun による retry では AccountLabelChange を重複挿入しない', async () => {
    const accountId = await createAccount('frank')
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `spam_${randomUUID().slice(0, 8)}`, description: 'テスト用ラベル' },
    })
    const labeledAt = new Date(Date.now() - 60 * 60 * 1000)
    await createAccountLabel({
      accountId,
      labelDefinitionId: labelDefinition.id,
      value: true,
      confidence: 0.9,
      reason: 'matched',
      labeledAt,
    })

    const firstGenerationId = `generation-${randomUUID()}`
    await buildAccountSummary(prisma, {
      generationId: firstGenerationId,
      sourceWatermarkAt: labeledAt,
    })
    await prisma.readModelPointer.upsert({
      where: { modelKey: 'account_summary' },
      create: { modelKey: 'account_summary', currentGenerationId: firstGenerationId },
      update: { currentGenerationId: firstGenerationId },
    })

    const removedAt = new Date()
    await createAccountLabel({
      accountId,
      labelDefinitionId: labelDefinition.id,
      value: false,
      confidence: 0.9,
      reason: 'no longer matched',
      labeledAt: removedAt,
    })

    const sourceCrawlRunId = `crawl-run-${randomUUID()}`
    // pointer を切り替えずに 2 回 build する。generation publish が
    // pointer 切り替え前に失敗し、同じ CrawlRun で retry された状況を模す。
    await buildAccountSummary(prisma, {
      generationId: `generation-${randomUUID()}`,
      sourceWatermarkAt: removedAt,
      sourceCrawlRunId,
    })
    await buildAccountSummary(prisma, {
      generationId: `generation-${randomUUID()}`,
      sourceWatermarkAt: removedAt,
      sourceCrawlRunId,
    })

    const changes = await prisma.accountLabelChange.findMany({
      where: { accountId, sourceId: sourceCrawlRunId },
    })
    expect(changes).toHaveLength(1)
  })

  it('ANALYZER_WORKER_CONCURRENCY > 1 で古い Crawl A と新しい Crawl B が同じ前世代から並行 build しても、両方の変化を正しい向きで記録する', async () => {
    const accountId = await createAccount('grace-concurrent')
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `spam_${randomUUID().slice(0, 8)}`, description: 'テスト用ラベル' },
    })
    const initialAt = new Date(Date.now() - 3 * 60 * 60 * 1000)
    const addedAt = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const removedAt = new Date(Date.now() - 60 * 60 * 1000)
    // C: 最初は false。A: addedAt で true になる。B: removedAt でさらに false に戻る。
    // A・B どちらも前世代 (C) からの並行 build を想定し、
    // previousGenerationId が指す generation のスナップショットではなく
    // AccountLabel 履歴上の直前値との比較だけで変化を組み立てられることを確認する。
    await createAccountLabel({
      accountId,
      labelDefinitionId: labelDefinition.id,
      value: false,
      confidence: 0.9,
      reason: 'no match',
      labeledAt: initialAt,
    })
    await createAccountLabel({
      accountId,
      labelDefinitionId: labelDefinition.id,
      value: true,
      confidence: 0.9,
      reason: 'matched',
      labeledAt: addedAt,
    })
    await createAccountLabel({
      accountId,
      labelDefinitionId: labelDefinition.id,
      value: false,
      confidence: 0.9,
      reason: 'no longer matched',
      labeledAt: removedAt,
    })

    const baseGenerationId = `generation-${randomUUID()}`
    await buildAccountSummary(prisma, {
      generationId: baseGenerationId,
      sourceWatermarkAt: initialAt,
    })
    await prisma.readModelPointer.upsert({
      where: { modelKey: 'account_summary' },
      create: { modelKey: 'account_summary', currentGenerationId: baseGenerationId },
      update: { currentGenerationId: baseGenerationId },
    })

    // A (古い watermark) と B (新しい watermark) を、どちらも同じ前世代 (baseGenerationId)
    // が current のまま並行 build する。commit 順が入れ替わっても結果が変わらないことを、
    // 呼び出し順を反転させたケースと合わせて確認する。
    await buildAccountSummary(prisma, {
      generationId: `generation-${randomUUID()}`,
      sourceWatermarkAt: removedAt,
      sourceCrawlRunId: `crawl-run-b-${randomUUID()}`,
    })
    await buildAccountSummary(prisma, {
      generationId: `generation-${randomUUID()}`,
      sourceWatermarkAt: addedAt,
      sourceCrawlRunId: `crawl-run-a-${randomUUID()}`,
    })

    const changes = await prisma.accountLabelChange.findMany({
      where: { accountId },
      orderBy: { changedAt: 'asc' },
    })
    expect(changes).toHaveLength(2)
    expect(changes[0]?.changeType).toBe('added')
    expect(changes[0]?.previousValue).toBe(false)
    expect(changes[0]?.newValue).toBe(true)
    expect(changes[0]?.changedAt.getTime()).toBe(addedAt.getTime())
    expect(changes[1]?.changeType).toBe('removed')
    expect(changes[1]?.previousValue).toBe(true)
    expect(changes[1]?.newValue).toBe(false)
    expect(changes[1]?.changedAt.getTime()).toBe(removedAt.getTime())
  })
})
