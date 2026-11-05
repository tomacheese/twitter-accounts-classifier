import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createSyntheticId, createIdBoundaryExtension } from 'id-boundary'
import type { LabelRule, LabelRuleResult } from '../labels/types'
import { LabelRuleRegistry } from '../labels/registry'
import { scanForStaleAccounts } from '../relabel-worker'
import { Prisma, PrismaClient } from '../generated/prisma'
import { getPrismaClient } from './client'
import { getOrThrow } from './label-test-support'
import {
  ensureLabelDefinitionsForRules,
  filterAccountIdsWithExistingLabels,
  findAccountIdsWithStaleLabels,
  loadAccountLabelRevs,
  loadAccountLabelStates,
  recordAccountLabelsBulkForAccounts,
  type AccountLabelBulkInput,
} from './label-repository'

const prisma = getPrismaClient()

// 乱数の ID は衝突しうるため、基点からの連番で一意にする。
const ID_BASE = BigInt(createSyntheticId())
let idCounter = 0n
function newId(): string {
  idCounter += 1n
  return String(ID_BASE + idCounter)
}

type Outcome = 'true' | 'false' | 'unevaluable'

function makeRule(key: string, version = '1.0.0'): LabelRule {
  return {
    key,
    description: `${key} description`,
    version,
    evaluate: () => ({ value: false, confidence: 1, reason: 'unused' }),
  }
}

function toResult(outcome: Outcome, tag: string): LabelRuleResult {
  switch (outcome) {
    case 'true': {
      return { value: true, confidence: 0.9, reason: `true-${tag}` }
    }
    case 'false': {
      return { value: false, confidence: 0.2, reason: `false-${tag}` }
    }
    case 'unevaluable': {
      return { value: false, confidence: 0.5, reason: `unevaluable-${tag}`, evaluable: false }
    }
  }
}

async function resetTables(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AccountActiveLabel", "AccountLabelState", "AccountLabelChange", "LabelRuleVersion", "LabelDefinition", "RelabelScanCursor", "AnalysisWorkItem", "Account" RESTART IDENTITY CASCADE',
  )
}

async function writeWithBaseline(
  accountId: string,
  idByKey: Map<string, number>,
  outcomes: Record<string, Outcome>,
  sourceId: string,
  ruleVersion = '1.0.0',
): Promise<string[]> {
  const states = await loadAccountLabelStates(prisma, [accountId])
  return recordAccountLabelsBulkForAccounts(prisma, {
    labels: Object.entries(outcomes).map(([key, outcome]) => ({
      accountId,
      labelDefinitionId: getOrThrow(idByKey, key),
      result: toResult(outcome, 'same'),
      method: key,
      ruleVersion,
    })),
    expectedRevByAccountId: new Map([[accountId, (states.get(accountId) as { rev: number }).rev]]),
    baselineByAccountId: states,
    sourceKind: 'relabel',
    sourceId,
  })
}

/** 現行のルール一覧として扱う (labelDefinitionId, ruleVersion) を、1.0.0 固定で作る。 */
function staleRulesOf(
  ids: Map<string, number>,
): { labelDefinitionId: number; ruleVersion: string }[] {
  return [...ids].map(([, labelDefinitionId]) => ({ labelDefinitionId, ruleVersion: '1.0.0' }))
}

/**
 * 評価入力を読んだ時点の rev を取ってから、1 アカウント分の結果を書く。
 * @returns CAS に失敗したアカウント ID
 */
async function writeOutcomes(
  accountId: string,
  ruleVersion: string,
  idByKey: Map<string, number>,
  outcomes: Record<string, Outcome>,
  sourceId: string,
  expectedRev?: number,
): Promise<string[]> {
  const labels: AccountLabelBulkInput[] = Object.entries(outcomes).map(([key, outcome]) => ({
    accountId,
    labelDefinitionId: getOrThrow(idByKey, key),
    result: toResult(outcome, sourceId),
    method: key,
    ruleVersion,
  }))
  const revs =
    expectedRev === undefined
      ? await loadAccountLabelRevs(prisma, [accountId])
      : new Map([[accountId, expectedRev]])
  return recordAccountLabelsBulkForAccounts(prisma, {
    labels,
    expectedRevByAccountId: revs,
    sourceKind: 'relabel',
    sourceId,
  })
}

describe.skipIf(!process.env.DATABASE_URL)('ラベル保存 (S+)', () => {
  beforeEach(async () => {
    await resetTables()
  })

  describe('ensureLabelDefinitionsForRules', () => {
    it('LabelDefinition と versionNo=1 の LabelRuleVersion を作り、currentRuleVersionNo を設定する', async () => {
      const idByKey = await ensureLabelDefinitionsForRules(prisma, [makeRule('a'), makeRule('b')])

      const definitions = await prisma.labelDefinition.findMany({ orderBy: { id: 'asc' } })
      expect(definitions.map((row) => [row.key, row.currentRuleVersionNo, row.retiredAt])).toEqual([
        ['a', 1, null],
        ['b', 1, null],
      ])
      expect(idByKey.get('a')).toBe(definitions[0].id)
      const versions = await prisma.labelRuleVersion.findMany({
        orderBy: { labelDefinitionId: 'asc' },
      })
      expect(versions.map((row) => [row.versionNo, row.ruleVersion])).toEqual([
        [1, '1.0.0'],
        [1, '1.0.0'],
      ])
    })

    it('既存のラベルに対して繰り返し実行しても、identity の採番値を消費しない', async () => {
      const rules = [makeRule('a'), makeRule('b')]
      for (let round = 0; round < 5; round += 1) await ensureLabelDefinitionsForRules(prisma, rules)
      const added = await ensureLabelDefinitionsForRules(prisma, [...rules, makeRule('c')])
      expect(added.get('c')).toBe(3)
    })

    it('同じ ruleVersion で再実行しても versionNo を増やさず、新しい ruleVersion で次の versionNo を採番する', async () => {
      const first = await ensureLabelDefinitionsForRules(prisma, [makeRule('a')])
      await ensureLabelDefinitionsForRules(prisma, [makeRule('a')])
      expect(await prisma.labelRuleVersion.count()).toBe(1)

      await ensureLabelDefinitionsForRules(prisma, [makeRule('a', '2.0.0')])
      const definition = await prisma.labelDefinition.findUniqueOrThrow({
        where: { id: getOrThrow(first, 'a') },
      })
      expect(definition.currentRuleVersionNo).toBe(2)
      const versions = await prisma.labelRuleVersion.findMany({ orderBy: { versionNo: 'asc' } })
      expect(versions.map((row) => [row.versionNo, row.ruleVersion])).toEqual([
        [1, '1.0.0'],
        [2, '2.0.0'],
      ])

      // 古い版へ戻しても versionNo は新規採番せず、既存の番号を指す。
      await ensureLabelDefinitionsForRules(prisma, [makeRule('a', '1.0.0')])
      const reverted = await prisma.labelDefinition.findUniqueOrThrow({
        where: { id: getOrThrow(first, 'a') },
      })
      expect(reverted.currentRuleVersionNo).toBe(1)
      expect(await prisma.labelRuleVersion.count()).toBe(2)
    })

    it('並行して同じ ruleVersion を採番しても versionNo が重複せず 1 行だけ作られる', async () => {
      await ensureLabelDefinitionsForRules(prisma, [makeRule('a')])
      await Promise.all(
        [1, 2, 3, 4].map(() => ensureLabelDefinitionsForRules(prisma, [makeRule('a', '2.0.0')])),
      )
      const versions = await prisma.labelRuleVersion.findMany({ orderBy: { versionNo: 'asc' } })
      expect(versions.map((row) => [row.versionNo, row.ruleVersion])).toEqual([
        [1, '1.0.0'],
        [2, '2.0.0'],
      ])
    })

    it('渡されなかったラベルは行と id を残したまま retiredAt を設定し、戻ってきたら解除する。id は再利用しない', async () => {
      const first = await ensureLabelDefinitionsForRules(prisma, [makeRule('a'), makeRule('b')])
      const bId = getOrThrow(first, 'b')

      await ensureLabelDefinitionsForRules(prisma, [makeRule('a')])
      const retired = await prisma.labelDefinition.findUniqueOrThrow({ where: { id: bId } })
      expect(retired.retiredAt).not.toBeNull()

      const added = await ensureLabelDefinitionsForRules(prisma, [makeRule('a'), makeRule('c')])
      expect(added.get('c')).toBeGreaterThan(bId)

      const restored = await ensureLabelDefinitionsForRules(prisma, [
        makeRule('a'),
        makeRule('b'),
        makeRule('c'),
      ])
      expect(restored.get('b')).toBe(bId)
      const back = await prisma.labelDefinition.findUniqueOrThrow({ where: { id: bId } })
      expect(back.retiredAt).toBeNull()
    })
  })

  describe('評価の記録と AccountLabelChange', () => {
    const states: ('none' | Outcome)[] = ['none', 'true', 'false', 'unevaluable']
    const nexts: Outcome[] = ['true', 'false', 'unevaluable']

    /** 旧トリガーと同じ規則: 評価不能は value=false として扱う。ただし true から評価不能へは新しい changeType。 */
    function expectedChange(prev: 'none' | Outcome, next: Outcome): string | null {
      if (next === 'true') return prev === 'true' ? null : 'added'
      if (prev !== 'true') return null
      return next === 'unevaluable' ? 'unevaluable' : 'removed'
    }

    it.each(states.flatMap((prev) => nexts.map((next) => [prev, next] as const)))(
      '%s から %s への遷移で、旧トリガーと同じ変更だけを記録する (true から評価不能は unevaluable)',
      async (prev, next) => {
        const idByKey = await ensureLabelDefinitionsForRules(prisma, [makeRule('a')])
        const accountId = newId()
        if (prev !== 'none') await writeOutcomes(accountId, '1.0.0', idByKey, { a: prev }, 'setup')

        const missed = await writeOutcomes(accountId, '1.0.0', idByKey, { a: next }, 'step')
        expect(missed).toEqual([])

        const rows = await prisma.accountLabelChange.findMany({
          where: { accountId, sourceId: 'step' },
        })
        const expected = expectedChange(prev, next)
        if (expected === null) {
          expect(rows).toEqual([])
          return
        }
        expect(rows).toHaveLength(1)
        const [row] = rows
        expect(row.changeType).toBe(expected)
        expect(row.labelDefinitionId).toBe(idByKey.get('a'))
        if (expected === 'added') {
          expect([row.newValue, row.newConfidence, row.newReason]).toEqual([true, 0.9, 'true-step'])
        } else {
          expect([row.previousValue, row.previousConfidence, row.previousReason]).toEqual([
            true,
            0.9,
            'true-setup',
          ])
          expect(row.newValue).toBe(expected === 'removed' ? false : null)
        }
      },
    )

    it('ランダムな遷移列で、有効ラベル行と versions の符号と変更履歴がモデルと一致する', async () => {
      const keys = ['a', 'b', 'c']
      const idByKey = await ensureLabelDefinitionsForRules(
        prisma,
        keys.map((key) => makeRule(key)),
      )
      const accounts = [newId(), newId()]
      let seed = 12_345
      const next = (): number => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
        return seed
      }
      const model = new Map<string, Outcome>()
      const expectedChanges: [string, string, string][] = []

      for (let step = 0; step < 150; step += 1) {
        const accountId = accounts[next() % accounts.length]
        const outcomes: Record<string, Outcome> = {}
        for (const key of keys) {
          if (next() % 2 === 0) outcomes[key] = nexts[next() % nexts.length]
        }
        if (Object.keys(outcomes).length === 0) continue
        for (const [key, outcome] of Object.entries(outcomes)) {
          const slot = `${accountId}:${key}`
          const change = expectedChange(model.get(slot) ?? 'none', outcome)
          if (change !== null) expectedChanges.push([accountId, key, change])
          model.set(slot, outcome)
        }
        expect(await writeOutcomes(accountId, '1.0.0', idByKey, outcomes, `s${step}`)).toEqual([])
      }

      const changes = await prisma.accountLabelChange.findMany({ orderBy: { id: 'asc' } })
      const keyById = new Map([...idByKey].map(([key, id]) => [id, key]))
      const actualChanges = changes.map((row) => [
        row.accountId,
        keyById.get(row.labelDefinitionId),
        row.changeType,
      ])
      // 1 回の書き込み内の順序は行の処理順で決まるため、集合として比較する。
      expect(actualChanges.toSorted()).toEqual(expectedChanges.toSorted())

      for (const accountId of accounts) {
        const state = await prisma.accountLabelState.findUniqueOrThrow({ where: { accountId } })
        const active = await prisma.accountActiveLabel.findMany({ where: { accountId } })
        const activeIds = new Set(active.map((row) => row.labelDefinitionId))
        for (const key of keys) {
          const id = getOrThrow(idByKey, key)
          const outcome = model.get(`${accountId}:${key}`)
          const slot = state.versions[id - 1] ?? 0
          if (outcome === undefined) {
            expect(slot).toBe(0)
          } else {
            expect(slot).toBe(outcome === 'unevaluable' ? -1 : 1)
          }
          expect(activeIds.has(id)).toBe(outcome === 'true')
        }
      }
    })

    it('ラベルを後から追加しても既存の状態行は書き換えず、書き込んだ時点で配列を伸ばす', async () => {
      const idByKey = await ensureLabelDefinitionsForRules(prisma, [makeRule('a')])
      const accountId = newId()
      await writeOutcomes(accountId, '1.0.0', idByKey, { a: 'true' }, 's1')
      const before = await prisma.accountLabelState.findUniqueOrThrow({ where: { accountId } })

      const withB = await ensureLabelDefinitionsForRules(prisma, [makeRule('a'), makeRule('b')])
      const unchanged = await prisma.accountLabelState.findUniqueOrThrow({ where: { accountId } })
      expect(unchanged).toEqual(before)
      expect(unchanged.versions).toEqual([1])

      await writeOutcomes(accountId, '1.0.0', withB, { b: 'false' }, 's2')
      const after = await prisma.accountLabelState.findUniqueOrThrow({ where: { accountId } })
      expect(after.versions).toEqual([1, 1])
      expect(after.rev).toBe(before.rev + 1)
    })

    it('ラベルの ruleVersion が versionNo に変換され、旧版の評価は旧 versionNo で残る', async () => {
      const idByKey = await ensureLabelDefinitionsForRules(prisma, [makeRule('a')])
      const accountId = newId()
      await writeOutcomes(accountId, '1.0.0', idByKey, { a: 'true' }, 's1')
      await ensureLabelDefinitionsForRules(prisma, [makeRule('a', '2.0.0')])

      const state = await prisma.accountLabelState.findUniqueOrThrow({ where: { accountId } })
      const active = await prisma.accountActiveLabel.findFirstOrThrow({ where: { accountId } })
      expect(state.versions).toEqual([1])
      expect(active.ruleVersionNo).toBe(1)

      await writeOutcomes(accountId, '2.0.0', idByKey, { a: 'true' }, 's2')
      const updated = await prisma.accountLabelState.findUniqueOrThrow({ where: { accountId } })
      const updatedActive = await prisma.accountActiveLabel.findFirstOrThrow({
        where: { accountId },
      })
      expect(updated.versions).toEqual([2])
      expect(updatedActive.ruleVersionNo).toBe(2)
    })

    it('未採番の ruleVersion は書き込まずに例外にする', async () => {
      const idByKey = await ensureLabelDefinitionsForRules(prisma, [makeRule('a')])
      await expect(writeOutcomes(newId(), '9.9.9', idByKey, { a: 'true' }, 's1')).rejects.toThrow(
        /LabelRuleVersion not found/,
      )
    })

    it('評価不能は value が true でも評価不能として記録し、true 行を残さない', async () => {
      const idByKey = await ensureLabelDefinitionsForRules(prisma, [makeRule('a')])
      const accountId = newId()
      await recordAccountLabelsBulkForAccounts(prisma, {
        labels: [
          {
            accountId,
            labelDefinitionId: getOrThrow(idByKey, 'a'),
            result: { value: true, confidence: 0.5, reason: 'r', evaluable: false },
            method: 'a',
            ruleVersion: '1.0.0',
          },
        ],
        expectedRevByAccountId: new Map([[accountId, 0]]),
        sourceKind: 'crawl',
      })
      expect(await prisma.accountActiveLabel.count({ where: { accountId } })).toBe(0)
      const state = await prisma.accountLabelState.findUniqueOrThrow({ where: { accountId } })
      expect(state.versions).toEqual([-1])
    })
  })

  describe('rev による CAS', () => {
    it('古い rev で評価した結果は、新しい評価を上書きせず戻り値で返る', async () => {
      const idByKey = await ensureLabelDefinitionsForRules(prisma, [makeRule('a')])
      const accountId = newId()
      await writeOutcomes(accountId, '1.0.0', idByKey, { a: 'false' }, 'setup')
      const staleRev = getOrThrow(await loadAccountLabelRevs(prisma, [accountId]), accountId)

      // 後から入った新しい評価 (true)。
      expect(await writeOutcomes(accountId, '1.0.0', idByKey, { a: 'true' }, 'newer')).toEqual([])

      // 古い入力で評価した false が、後から書こうとする。
      const missed = await writeOutcomes(
        accountId,
        '1.0.0',
        idByKey,
        { a: 'false' },
        'older',
        staleRev,
      )
      expect(missed).toEqual([accountId])

      const active = await prisma.accountActiveLabel.findFirstOrThrow({ where: { accountId } })
      expect(active.sourceId).toBe('newer')
      expect(
        await prisma.accountLabelChange.count({ where: { accountId, sourceId: 'older' } }),
      ).toBe(0)
    })

    it('状態行が無い新規アカウントの同時初回書き込みでは、1 つだけが反映され、もう 1 つは戻り値で返る', async () => {
      const idByKey = await ensureLabelDefinitionsForRules(prisma, [makeRule('a')])
      const accountId = newId()

      const results = await Promise.all([
        writeOutcomes(accountId, '1.0.0', idByKey, { a: 'true' }, 'writer-1', 0),
        writeOutcomes(accountId, '1.0.0', idByKey, { a: 'false' }, 'writer-2', 0),
      ])

      expect(results.flat()).toEqual([accountId])
      const state = await prisma.accountLabelState.findUniqueOrThrow({ where: { accountId } })
      expect(state.rev).toBe(1)
      expect(await prisma.accountLabelState.count({ where: { accountId } })).toBe(1)
    })

    it('rev が 0 でないのに状態行が無いアカウントは、行を作らず戻り値で返る', async () => {
      const idByKey = await ensureLabelDefinitionsForRules(prisma, [makeRule('a')])
      const accountId = newId()

      expect(await writeOutcomes(accountId, '1.0.0', idByKey, { a: 'true' }, 'w', 5)).toEqual([
        accountId,
      ])
      expect(await prisma.accountLabelState.count({ where: { accountId } })).toBe(0)
    })

    it('同じ rev を前提にした並行書き込みは、CAS に成功した回数だけ rev が進む', async () => {
      const idByKey = await ensureLabelDefinitionsForRules(prisma, [makeRule('a')])
      const accountId = newId()
      await writeOutcomes(accountId, '1.0.0', idByKey, { a: 'false' }, 'setup')

      const outcomes: Outcome[] = ['true', 'false', 'unevaluable', 'true', 'false', 'true']
      const results = await Promise.all(
        outcomes.map((outcome, index) =>
          writeOutcomes(accountId, '1.0.0', idByKey, { a: outcome }, `w${index}`, 1),
        ),
      )

      const succeeded = results.filter((missed) => missed.length === 0).length
      expect(succeeded).toBe(1)
      const state = await prisma.accountLabelState.findUniqueOrThrow({ where: { accountId } })
      expect(state.rev).toBe(2)
    })

    it('複数アカウントを accountId の昇順で書き、互いに逆順の呼び出しが並行してもデッドロックしない', async () => {
      const idByKey = await ensureLabelDefinitionsForRules(prisma, [makeRule('a')])
      const accounts = Array.from({ length: 20 }, () => newId())
      const build = (order: string[], tag: string): Promise<string[]> =>
        recordAccountLabelsBulkForAccounts(prisma, {
          labels: order.map((accountId) => ({
            accountId,
            labelDefinitionId: getOrThrow(idByKey, 'a'),
            result: toResult('true', tag),
            method: 'a',
            ruleVersion: '1.0.0',
          })),
          expectedRevByAccountId: new Map(accounts.map((accountId) => [accountId, 0])),
          sourceKind: 'relabel',
          sourceId: tag,
        })

      const results = await Promise.all([
        build(accounts, 'asc'),
        build(accounts.toReversed(), 'desc'),
      ])

      // 一方が全アカウントを反映し、もう一方は全アカウントが CAS で戻る。
      expect(results.map((missed) => missed.length).toSorted()).toEqual([0, accounts.length])
    })
  })

  describe('状態と同じ結果の行の省略', () => {
    it('全行が状態と同じアカウントには何も書かず、rev も進めない', async () => {
      const idByKey = await ensureLabelDefinitionsForRules(prisma, [
        makeRule('a'),
        makeRule('b'),
        makeRule('c'),
      ])
      const accountId = newId()
      const outcomes: Record<string, Outcome> = { a: 'true', b: 'false', c: 'unevaluable' }
      await writeWithBaseline(accountId, idByKey, outcomes, 'first')
      const before = await prisma.accountLabelState.findUniqueOrThrow({ where: { accountId } })

      expect(await writeWithBaseline(accountId, idByKey, outcomes, 'second')).toEqual([])

      expect(await prisma.accountLabelState.findUniqueOrThrow({ where: { accountId } })).toEqual(
        before,
      )
      const active = await prisma.accountActiveLabel.findFirstOrThrow({ where: { accountId } })
      expect(active.sourceId).toBe('first')
    })

    it('違う行だけを書き、他のラベルの状態はそのまま、rev は 1 だけ進む', async () => {
      const idByKey = await ensureLabelDefinitionsForRules(prisma, [
        makeRule('a'),
        makeRule('b'),
        makeRule('c'),
      ])
      const accountId = newId()
      await writeWithBaseline(
        accountId,
        idByKey,
        { a: 'true', b: 'false', c: 'unevaluable' },
        'first',
      )
      const before = await prisma.accountLabelState.findUniqueOrThrow({ where: { accountId } })

      await writeWithBaseline(
        accountId,
        idByKey,
        { a: 'true', b: 'true', c: 'unevaluable' },
        'second',
      )

      const after = await prisma.accountLabelState.findUniqueOrThrow({ where: { accountId } })
      expect(after.rev).toBe(before.rev + 1)
      expect(after.versions).toEqual(before.versions)
      const changes = await prisma.accountLabelChange.findMany({
        where: { accountId, sourceId: 'second' },
      })
      expect(changes.map((row) => [row.labelDefinitionId, row.changeType])).toEqual([
        [idByKey.get('b'), 'added'],
      ])
    })

    it('true から false への変化と、reason だけの変化は省略されない', async () => {
      const idByKey = await ensureLabelDefinitionsForRules(prisma, [makeRule('a'), makeRule('b')])
      const accountId = newId()
      await writeWithBaseline(accountId, idByKey, { a: 'true', b: 'true' }, 'first')
      const states = await loadAccountLabelStates(prisma, [accountId])
      const state = states.get(accountId) as { rev: number }

      const missed = await recordAccountLabelsBulkForAccounts(prisma, {
        labels: [
          {
            accountId,
            labelDefinitionId: getOrThrow(idByKey, 'a'),
            result: toResult('false', 'x'),
            method: 'a',
            ruleVersion: '1.0.0',
          },
          {
            accountId,
            labelDefinitionId: getOrThrow(idByKey, 'b'),
            result: { value: true, confidence: 0.9, reason: 'a different reason' },
            method: 'b',
            ruleVersion: '1.0.0',
          },
        ],
        expectedRevByAccountId: new Map([[accountId, state.rev]]),
        baselineByAccountId: states,
        sourceKind: 'relabel',
        sourceId: 'second',
      })

      expect(missed).toEqual([])
      const active = await prisma.accountActiveLabel.findMany({ where: { accountId } })
      expect(active.map((row) => [row.labelDefinitionId, row.reason])).toEqual([
        [idByKey.get('b'), 'a different reason'],
      ])
    })

    it('古い baseline のまま変更行を書こうとすると、CAS に負けて戻り値で返る', async () => {
      const idByKey = await ensureLabelDefinitionsForRules(prisma, [makeRule('a')])
      const accountId = newId()
      await writeWithBaseline(accountId, idByKey, { a: 'false' }, 'first')
      const states = await loadAccountLabelStates(prisma, [accountId])
      const staleRev = (states.get(accountId) as { rev: number }).rev
      await writeOutcomes(accountId, '1.0.0', idByKey, { a: 'true' }, 'newer')

      const missed = await recordAccountLabelsBulkForAccounts(prisma, {
        labels: [
          {
            accountId,
            labelDefinitionId: getOrThrow(idByKey, 'a'),
            result: toResult('unevaluable', 'older'),
            method: 'a',
            ruleVersion: '1.0.0',
          },
        ],
        expectedRevByAccountId: new Map([[accountId, staleRev]]),
        baselineByAccountId: states,
        sourceKind: 'relabel',
        sourceId: 'older',
      })

      expect(missed).toEqual([accountId])
      expect(await prisma.accountActiveLabel.count({ where: { accountId } })).toBe(1)
    })
  })

  describe('stale 判定', () => {
    it('未評価と現行版以外のラベルを持つアカウントだけを stale として返す', async () => {
      const idByKey = await ensureLabelDefinitionsForRules(prisma, [makeRule('a'), makeRule('b')])
      const rules = [
        { labelDefinitionId: getOrThrow(idByKey, 'a'), ruleVersion: '1.0.0' },
        { labelDefinitionId: getOrThrow(idByKey, 'b'), ruleVersion: '1.0.0' },
      ]
      const [unevaluated, partial, evaluated, unevaluable] = [newId(), newId(), newId(), newId()]
      await writeOutcomes(partial, '1.0.0', idByKey, { a: 'true' }, 's')
      await writeOutcomes(evaluated, '1.0.0', idByKey, { a: 'false', b: 'true' }, 's')
      await writeOutcomes(unevaluable, '1.0.0', idByKey, { a: 'unevaluable', b: 'false' }, 's')

      const stale = await findAccountIdsWithStaleLabels(
        prisma,
        [unevaluated, partial, evaluated, unevaluable],
        rules,
      )
      expect(stale.toSorted()).toEqual([unevaluated, partial].toSorted())
    })

    it('ラベルを追加すると状態行を書き換えずに全員が stale になり、評価すると二度と stale にならない', async () => {
      const idByKey = await ensureLabelDefinitionsForRules(prisma, [makeRule('a')])
      const accounts = [newId(), newId()]
      for (const accountId of accounts) {
        await writeOutcomes(accountId, '1.0.0', idByKey, { a: 'true' }, 's')
      }
      expect(await findAccountIdsWithStaleLabels(prisma, accounts, staleRulesOf(idByKey))).toEqual(
        [],
      )
      const revsBefore = await loadAccountLabelRevs(prisma, accounts)

      const withB = await ensureLabelDefinitionsForRules(prisma, [makeRule('a'), makeRule('b')])
      const staleAfterAddingB = await findAccountIdsWithStaleLabels(
        prisma,
        accounts,
        staleRulesOf(withB),
      )
      expect(staleAfterAddingB.toSorted()).toEqual(accounts.toSorted())
      expect(await loadAccountLabelRevs(prisma, accounts)).toEqual(revsBefore)

      for (const accountId of accounts) {
        await writeOutcomes(accountId, '1.0.0', withB, { b: 'unevaluable' }, 's2')
      }
      for (let round = 0; round < 3; round += 1) {
        expect(await findAccountIdsWithStaleLabels(prisma, accounts, staleRulesOf(withB))).toEqual(
          [],
        )
      }
    })

    it('ルールの版が上がると評価済みのアカウントも stale になる', async () => {
      const idByKey = await ensureLabelDefinitionsForRules(prisma, [makeRule('a')])
      const accountId = newId()
      await writeOutcomes(accountId, '1.0.0', idByKey, { a: 'false' }, 's')
      await ensureLabelDefinitionsForRules(prisma, [makeRule('a', '2.0.0')])

      expect(
        await findAccountIdsWithStaleLabels(
          prisma,
          [accountId],
          [{ labelDefinitionId: getOrThrow(idByKey, 'a'), ruleVersion: '2.0.0' }],
        ),
      ).toEqual([accountId])
    })

    it('scanForStaleAccounts は未評価のアカウントだけに account_relabel を要求し、評価済みには要求しない', async () => {
      const rules = [makeRule('a'), makeRule('b')]
      const registry = new LabelRuleRegistry()
      for (const rule of rules) registry.register(rule)
      const idByKey = await ensureLabelDefinitionsForRules(prisma, rules)
      const [evaluated, unevaluated] = [newId(), newId()].toSorted((left, right) =>
        BigInt(left) < BigInt(right) ? -1 : 1,
      )
      for (const id of [evaluated, unevaluated]) {
        await prisma.account.create({
          data: {
            id,
            screenName: `synthetic_${id}`,
            displayName: 'Synthetic account',
            followersCount: 0,
            followingCount: 0,
            tweetCount: 0,
            accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
          },
        })
      }
      await writeOutcomes(evaluated, '1.0.0', idByKey, { a: 'false', b: 'unevaluable' }, 's')

      const result = await scanForStaleAccounts(prisma, {
        registry,
        labelDefinitionIds: idByKey,
        batchSize: 100,
      })

      expect(result.requested).toBe(1)
      const items = await prisma.analysisWorkItem.findMany({ where: { kind: 'account_relabel' } })
      expect(items.map((item) => item.triggerId)).toEqual([unevaluated])
    })

    it('filterAccountIdsWithExistingLabels は状態行のあるアカウントだけを返す', async () => {
      const idByKey = await ensureLabelDefinitionsForRules(prisma, [makeRule('a')])
      const [labeled, never] = [newId(), newId()]
      await writeOutcomes(labeled, '1.0.0', idByKey, { a: 'false' }, 's')

      expect(await filterAccountIdsWithExistingLabels(prisma, [labeled, never])).toEqual(
        new Set([labeled]),
      )
      expect(await filterAccountIdsWithExistingLabels(prisma, [])).toEqual(new Set())
    })
  })

  // アプリ用ロール (テーブルの所有者でもスーパーユーザーでもない) の接続先。権限の検査はこの接続でだけ行う。
  describe.skipIf(!process.env.CRAWLER_ROLE_DATABASE_URL)('アプリ用ロールの権限', () => {
    const appPrisma = new PrismaClient({
      datasourceUrl: process.env.CRAWLER_ROLE_DATABASE_URL,
    }).$extends(createIdBoundaryExtension(Prisma)) as unknown as PrismaClient

    afterAll(async () => {
      await appPrisma.$disconnect()
    })

    it('set_label_result 経由の書き込みは通り、監査トリガーが変更履歴を記録する', async () => {
      const idByKey = await ensureLabelDefinitionsForRules(prisma, [makeRule('a')])
      const accountId = newId()

      const missed = await recordAccountLabelsBulkForAccounts(appPrisma, {
        labels: [
          {
            accountId,
            labelDefinitionId: getOrThrow(idByKey, 'a'),
            result: toResult('true', 'role'),
            method: 'a',
            ruleVersion: '1.0.0',
          },
        ],
        expectedRevByAccountId: new Map([[accountId, 0]]),
        sourceKind: 'crawl',
        sourceId: 'role-run',
      })

      expect(missed).toEqual([])
      expect(await prisma.accountLabelChange.count({ where: { accountId } })).toBe(1)
    })

    it('トリガーを迂回する直接の INSERT・UPDATE・DELETE を権限で拒否する', async () => {
      const idByKey = await ensureLabelDefinitionsForRules(prisma, [makeRule('a')])
      const accountId = newId()
      await writeOutcomes(accountId, '1.0.0', idByKey, { a: 'true' }, 'setup')
      const labelId = getOrThrow(idByKey, 'a')

      await expect(
        appPrisma.$executeRaw`INSERT INTO "AccountActiveLabel" ("accountId", "labelDefinitionId", "ruleVersionNo", "confidence", "reason", "method", "labeledAt") VALUES (${newId()}::bigint, ${labelId}::smallint, 1, 1, 'r', 'm', now())`,
      ).rejects.toThrow(/permission denied for table AccountActiveLabel/)
      await expect(
        appPrisma.$executeRaw`UPDATE "AccountActiveLabel" SET "confidence" = 0 WHERE "accountId" = ${accountId}::bigint`,
      ).rejects.toThrow(/permission denied for table AccountActiveLabel/)
      await expect(
        appPrisma.$executeRaw`DELETE FROM "AccountActiveLabel" WHERE "accountId" = ${accountId}::bigint`,
      ).rejects.toThrow(/permission denied for table AccountActiveLabel/)
      await expect(
        appPrisma.$executeRaw`UPDATE "AccountLabelState" SET "rev" = 99 WHERE "accountId" = ${accountId}::bigint`,
      ).rejects.toThrow(/permission denied for table AccountLabelState/)

      expect(await prisma.accountActiveLabel.count({ where: { accountId } })).toBe(1)
    })
  })

  describe('書き込みの規模', () => {
    it('多数アカウントを少ない往復でまとめて書き、全行を反映する', async () => {
      const rules = Array.from({ length: 49 }, (_, index) => makeRule(`rule_${index}`))
      const idByKey = await ensureLabelDefinitionsForRules(prisma, rules)
      const accounts = Array.from({ length: 300 }, () => newId())
      const labels: AccountLabelBulkInput[] = accounts.flatMap((accountId, accountIndex) =>
        rules.map((rule, ruleIndex) => ({
          accountId,
          labelDefinitionId: getOrThrow(idByKey, rule.key),
          result: toResult((accountIndex + ruleIndex) % 5 === 0 ? 'true' : 'false', 'bulk'),
          method: rule.key,
          ruleVersion: '1.0.0',
        })),
      )

      const startedAt = Date.now()
      const missed = await recordAccountLabelsBulkForAccounts(prisma, {
        labels,
        expectedRevByAccountId: new Map(accounts.map((accountId) => [accountId, 0])),
        sourceKind: 'relabel',
        sourceId: 'bulk',
      })
      const elapsedMs = Date.now() - startedAt

      expect(missed).toEqual([])
      expect(await prisma.accountLabelState.count()).toBe(accounts.length)
      expect(await prisma.accountActiveLabel.count()).toBe(
        labels.filter((label) => label.result.value).length,
      )
      expect(await prisma.accountLabelChange.count()).toBe(
        labels.filter((label) => label.result.value).length,
      )
      // 大量の書き込みが現実的な時間で終わることだけを確かめる。
      expect(elapsedMs).toBeLessThan(30_000)
    }, 60_000)
  })
})
