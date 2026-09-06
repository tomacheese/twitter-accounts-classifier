import { describe, expect, it } from 'vitest'
import { parseClassificationSnapshot } from './account-classification-snapshot'

describe('parseClassificationSnapshot', () => {
  it('converts a valid snapshot array into LabelAtWatermark rows with the given accountId', () => {
    const result = parseClassificationSnapshot('acct_1', [
      {
        labelDefinitionId: 'def_1',
        value: true,
        confidence: 0.9,
        reason: 'r',
        method: 'rule',
        ruleVersion: 'v1',
        evaluable: true,
        labeledAt: '2026-01-02T00:00:00.000Z',
      },
    ])

    expect(result).toEqual([
      {
        accountId: 'acct_1',
        labelDefinitionId: 'def_1',
        value: true,
        confidence: 0.9,
        reason: 'r',
        method: 'rule',
        ruleVersion: 'v1',
        evaluable: true,
        labeledAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ])
  })

  it('returns an empty array for an empty snapshot', () => {
    expect(parseClassificationSnapshot('acct_1', [])).toEqual([])
  })

  it('throws when the snapshot is not an array', () => {
    expect(() => parseClassificationSnapshot('acct_1', { labelDefinitionId: 'def_1' })).toThrow(
      'classificationSnapshot must be an array',
    )
  })

  it('throws when an entry is missing a required field', () => {
    expect(() =>
      parseClassificationSnapshot('acct_1', [
        {
          labelDefinitionId: 'def_1',
          value: true,
          confidence: 0.9,
          reason: 'r',
          method: 'rule',
          // ruleVersion が欠落している
          evaluable: true,
          labeledAt: '2026-01-02T00:00:00.000Z',
        },
      ]),
    ).toThrow('classificationSnapshot[0] is missing a required field')
  })
})
